import { useSyncExternalStore } from "react";
import {
  ApiHttpError,
  getNotification,
  getNotifications,
  markNotificationRead,
  type NotificationDetailDto,
  type NotificationItemDto,
} from "../api/client";
import { recordDiagnosticEvent } from "./diagnostics";
import { getSession, subscribeSession } from "./store";

// Announcements from the bot (Рассылка → TobeVPN), as on the Android client:
// the feed, one announcement, its read mark and the dot on the Home bell.
// The feed is requested on events only — once when the app opens (for the
// bell), when the user enters the section, and on Refresh — never in the
// background. Concurrent loads share one request.

export type AnnouncementsError =
  | { kind: "network" }
  | { kind: "forbidden" }
  | { kind: "not-found" }
  | { kind: "rate-limited"; retryAfterSeconds: number | null };

export interface AnnouncementsFeedState {
  /** The last feed the server returned; null until the first one arrives. */
  items: NotificationItemDto[] | null;
  loading: boolean;
  error: AnnouncementsError | null;
}

let feed: AnnouncementsFeedState = { items: null, loading: false, error: null };
let inFlight: Promise<void> | null = null;
let openedThisRun = false;
const listeners = new Set<() => void>();

function setFeed(next: AnnouncementsFeedState): void {
  feed = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnnouncementsFeed(): AnnouncementsFeedState {
  return useSyncExternalStore(subscribe, () => feed, () => feed);
}

const getHasUnread = () => feed.items?.some((item) => item.read_at === null) ?? false;

/** The dot on the bell: an unread announcement in the last feed. */
export function useAnnouncementsUnread(): boolean {
  return useSyncExternalStore(subscribe, getHasUnread, getHasUnread);
}

export function announcementsError(error: unknown): AnnouncementsError {
  if (error instanceof ApiHttpError) {
    if (error.status === 404) return { kind: "not-found" };
    if (error.status === 403) return { kind: "forbidden" };
    if (error.status === 429) {
      const seconds = Number.parseInt(error.retryAfter ?? "", 10);
      return { kind: "rate-limited", retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
    }
  }
  return { kind: "network" };
}

/** One feed request; callers arriving while it runs wait for the same one. */
export function loadAnnouncements(): Promise<void> {
  if (inFlight) return inFlight;
  setFeed({ ...feed, loading: true, error: null });
  const recipient = recipientKey();
  inFlight = (async () => {
    try {
      const response = await getNotifications();
      if (recipient !== recipientKey()) return;
      setFeed({ items: response.data ?? [], loading: false, error: null });
    } catch (error) {
      if (recipient !== recipientKey()) return;
      const failure = announcementsError(error);
      recordDiagnosticEvent("Announcements", `Feed request failed: ${failure.kind}`, "W");
      setFeed({ ...feed, loading: false, error: failure });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The app opened: one feed request per run, for the bell. */
export function announcementsOnAppOpened(): void {
  if (openedThisRun) return;
  openedThisRun = true;
  void loadAnnouncements();
}

export const isAnnouncementId = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export async function loadAnnouncement(id: string): Promise<NotificationDetailDto> {
  if (!isAnnouncementId(id)) throw new ApiHttpError(404, "Notification not found");
  const response = await getNotification(id);
  if (!response.data) throw new Error("Empty announcement");
  return response.data;
}

/**
 * The full text is on screen. Returns the server's read time (a repeat keeps
 * the first one) and updates the feed entry with it.
 */
export async function markAnnouncementRead(id: string): Promise<string | null> {
  if (!isAnnouncementId(id)) return null;
  let readAt: string | null = null;
  try {
    readAt = (await markNotificationRead(id)).data?.read_at ?? null;
  } catch (error) {
    // A 401 renewed the session but POSTs are not repeated by request(); the
    // mark is idempotent, so one more try is safe.
    if (!(error instanceof ApiHttpError) || error.status !== 401) return null;
    readAt = await markNotificationRead(id).then((r) => r.data?.read_at ?? null, () => null);
  }
  if (readAt && feed.items) {
    setFeed({
      ...feed,
      items: feed.items.map((item) => (item.id === id ? { ...item, read_at: readAt } : item)),
    });
  }
  return readAt;
}

// The server picks the recipient from the session: after a sign-in, sign-out
// or account change the previous recipient's feed is dropped.
function recipientKey(): string {
  const session = getSession();
  return `${session.deviceId}:${session.telegramId ?? "guest"}`;
}

let lastRecipient = recipientKey();
subscribeSession(() => {
  const next = recipientKey();
  if (next === lastRecipient) return;
  lastRecipient = next;
  inFlight = null;
  setFeed({ items: null, loading: false, error: null });
  if (openedThisRun) void loadAnnouncements();
});
