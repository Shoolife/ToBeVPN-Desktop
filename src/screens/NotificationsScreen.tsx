import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NotificationDetailDto, NotificationItemDto } from "../api/client";
import BrandLoader from "../components/BrandLoader";
import MaterialIcon, { type MaterialIconName } from "../components/MaterialIcon";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import { getSavedLang, t, tf } from "../i18n";
import {
  announcementsError,
  announcementsOnFeedEntered,
  loadAnnouncement,
  loadAnnouncements,
  markAnnouncementRead,
  useAnnouncementsFeed,
  type AnnouncementsError,
} from "../session/announcements";
import "./NotificationsScreen.css";

// The announcements feed (bell on Home) and one announcement, as on Android.
// The feed lives in session/announcements, so returning from an announcement
// does not load it again.

type DetailState =
  | { kind: "loading" }
  | { kind: "loaded"; detail: NotificationDetailDto }
  | { kind: "failed"; error: AnnouncementsError };

export default function NotificationsScreen({
  onBack,
  onOpenPlans,
}: {
  onBack: () => void;
  onOpenPlans: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // The view that is leaving, kept for one cross-fade (as Settings sections
  // and App screens do): null is the feed, a string an announcement.
  const [leaving, setLeaving] = useState<{ view: string | null; forward: boolean } | null>(null);
  const timerRef = useRef<number | null>(null);

  // Entering the section: the feed loaded on app open is shown; the server
  // is asked only if there is none yet.
  useEffect(() => {
    announcementsOnFeedEntered();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const show = (next: string | null) => {
    if (next === openId) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setLeaving({ view: openId, forward: next !== null });
    setOpenId(next);
    timerRef.current = window.setTimeout(() => {
      setLeaving(null);
      timerRef.current = null;
    }, 700);
  };

  const render = (view: string | null) =>
    view === null ? (
      <NotificationsFeed onBack={onBack} onOpen={(id) => show(id)} />
    ) : (
      <NotificationDetail id={view} onBack={() => show(null)} onOpenPlans={onOpenPlans} />
    );
  const keyOf = (view: string | null) => (view === null ? "feed" : `detail:${view}`);

  return (
    <div className="notif-viewport">
      {leaving && (
        <div
          key={keyOf(leaving.view)}
          className={`screen-layer ${leaving.forward ? "screen-exit-to-left" : "screen-exit-to-right"}`}
        >
          {render(leaving.view)}
        </div>
      )}
      <div
        key={keyOf(openId)}
        className={`screen-layer ${leaving ? (leaving.forward ? "screen-enter-from-right" : "screen-enter-from-left") : ""}`}
      >
        {render(openId)}
      </div>
    </div>
  );
}

function NotificationsFeed({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const feed = useAnnouncementsFeed();
  const items = feed.items;
  const refreshable = items !== null || feed.error !== null;

  return (
    <div className="notif-root">
      <TopBar onBack={onBack}>
        {refreshable && (
          <button
            className="notif-topbar__btn"
            onClick={() => void loadAnnouncements()}
            disabled={feed.loading}
            title={t("refresh")}
            aria-label={t("refresh")}
          >
            <MaterialIcon name="refresh" size={22} className={feed.loading ? "notif-spin" : undefined} />
          </button>
        )}
      </TopBar>

      {items === null && feed.error ? (
        <Message
          icon="cloudOff"
          title={t("notifications_error_title")}
          text={errorText(feed.error)}
          actionLabel={t("retry")}
          onAction={() => void loadAnnouncements()}
        />
      ) : items === null ? (
        <div className="notif-center"><BrandLoader /></div>
      ) : items.length === 0 ? (
        <Message icon="notifications" title={t("notifications_empty_title")} text={t("notifications_empty_text")} />
      ) : (
        <ScrollEdgeAffordance className="notif-list">
          {/* A failed refresh keeps the list and says so on top. */}
          {feed.error && <div className="notif-inline-error">{errorText(feed.error)}</div>}
          {items.map((item) => (
            <FeedCard key={item.id} item={item} onClick={() => onOpen(item.id)} />
          ))}
        </ScrollEdgeAffordance>
      )}
    </div>
  );
}

function FeedCard({ item, onClick }: { item: NotificationItemDto; onClick: () => void }) {
  const unread = item.read_at === null;
  const date = formatPublishedAt(item.published_at);
  return (
    <button type="button" className={`notif-card ${unread ? "notif-card--unread" : ""}`} onClick={onClick}>
      <span className="notif-icon-tile"><MaterialIcon name="notifications" size={24} /></span>
      <span className="notif-card__body">
        <span className="notif-card__head">
          <span className="notif-card__title">{item.title ?? ""}</span>
          {unread && <span className="notif-badge">{t("notification_new")}</span>}
        </span>
        {item.preview && <span className="notif-card__preview">{item.preview}</span>}
        {date && <span className="notif-card__date">{date}</span>}
      </span>
    </button>
  );
}

function NotificationDetail({
  id,
  onBack,
  onOpenPlans,
}: {
  id: string;
  onBack: () => void;
  onOpenPlans: () => void;
}) {
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    loadAnnouncement(id).then(
      (detail) => active && setState({ kind: "loaded", detail }),
      (error) => active && setState({ kind: "failed", error: announcementsError(error) }),
    );
    return () => {
      active = false;
    };
  }, [id, attempt]);

  // The full text is drawn: this is when it counts as read (once).
  const loadedId = state.kind === "loaded" && state.detail.read_at === null ? state.detail.id : null;
  useEffect(() => {
    if (!loadedId) return;
    let active = true;
    void markAnnouncementRead(loadedId).then((readAt) => {
      if (!active || !readAt) return;
      setState((current) =>
        current.kind === "loaded" && current.detail.id === loadedId
          ? { kind: "loaded", detail: { ...current.detail, read_at: readAt } }
          : current,
      );
    });
    return () => {
      active = false;
    };
  }, [loadedId]);

  return (
    <div className="notif-root">
      <TopBar onBack={onBack} />
      {state.kind === "loading" ? (
        <div className="notif-center"><BrandLoader /></div>
      ) : state.kind === "failed" ? (
        state.error.kind === "not-found" ? (
          <Message
            icon="notifications"
            title={t("notification_unavailable_title")}
            text={t("notification_unavailable_text")}
            actionLabel={t("notification_back_to_feed")}
            onAction={onBack}
          />
        ) : (
          <Message
            icon="cloudOff"
            title={t("notification_detail_error_title")}
            text={errorText(state.error)}
            actionLabel={t("retry")}
            onAction={() => setAttempt((value) => value + 1)}
          />
        )
      ) : (
        <ScrollEdgeAffordance className="notif-detail">
          <div className="notif-detail__card">
            <div className="notif-detail__heading">
              <span className="notif-icon-tile notif-icon-tile--large"><MaterialIcon name="notifications" size={27} /></span>
              <div>
                <h2 className="notif-detail__title">{state.detail.title ?? ""}</h2>
                {formatPublishedAt(state.detail.published_at) && (
                  <div className="notif-detail__date">{formatPublishedAt(state.detail.published_at)}</div>
                )}
              </div>
            </div>
            {/* Plain text; line breaks kept by white-space: pre-wrap. */}
            <div className="notif-detail__body">{state.detail.body ?? state.detail.preview ?? ""}</div>
          </div>
          <DetailAction detail={state.detail} onOpenPlans={onOpenPlans} />
        </ScrollEdgeAffordance>
      )}
    </div>
  );
}

/**
 * The button under the text: "plans" opens the plans, "url" hands action_url
 * to the system (browser, or Telegram for t.me). Anything else, an empty
 * label or a bad link shows just the text.
 */
function DetailAction({ detail, onOpenPlans }: { detail: NotificationDetailDto; onOpenPlans: () => void }) {
  if (detail.action === "plans") {
    return (
      <button type="button" className="notif-primary-button notif-detail__action" onClick={onOpenPlans}>
        {t("notification_open_plans")}
      </button>
    );
  }
  if (detail.action === "url") {
    const label = detail.action_label?.trim() ?? "";
    const url = webLinkOrNull(detail.action_url);
    if (!label || !url) return null;
    return (
      <button
        type="button"
        className="notif-primary-button notif-detail__action"
        onClick={() => {
          openUrl(url).catch((e) => console.warn("[notifications] open link failed", e));
        }}
      >
        <MaterialIcon name="link" size={20} />
        {label}
      </button>
    );
  }
  return null;
}

/** action_url when it is a proper http(s) link with a host. */
function webLinkOrNull(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function TopBar({ onBack, children }: { onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="notif-topbar">
      <button className="notif-topbar__btn" onClick={onBack} aria-label={t("back")}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span className="notif-topbar__title">{t("notifications_title")}</span>
      <span className="notif-topbar__spacer" />
      {children}
    </div>
  );
}

function Message({
  icon,
  title,
  text,
  actionLabel,
  onAction,
}: {
  icon: MaterialIconName;
  title: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="notif-center notif-message">
      <MaterialIcon name={icon} size={54} className="notif-message__icon" />
      <div className="notif-message__title">{title}</div>
      <div className="notif-message__text">{text}</div>
      {actionLabel && (
        <button type="button" className="notif-primary-button notif-message__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function errorText(error: AnnouncementsError): string {
  if (error.kind === "rate-limited") {
    return error.retryAfterSeconds
      ? tf("notifications_error_rate_limited_seconds", error.retryAfterSeconds)
      : t("notifications_error_rate_limited");
  }
  if (error.kind === "forbidden") return t("notifications_error_forbidden");
  return t("notifications_error_network");
}

/** "23 ноября, 12:00" in local time; the year only when it is not this one. */
function formatPublishedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const locale = getSavedLang() === "ru" ? "ru-RU" : "en-GB";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}
