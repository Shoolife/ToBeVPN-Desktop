import { useEffect, useState } from "react";
import type { NotificationDetailDto, NotificationItemDto } from "../api/client";
import BrandLoader from "../components/BrandLoader";
import MaterialIcon, { type MaterialIconName } from "../components/MaterialIcon";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import { getSavedLang, t, tf } from "../i18n";
import {
  announcementsError,
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

  // Entering the section: one feed request.
  useEffect(() => {
    void loadAnnouncements();
  }, []);

  return openId ? (
    <NotificationDetail id={openId} onBack={() => setOpenId(null)} onOpenPlans={onOpenPlans} />
  ) : (
    <NotificationsFeed onBack={onBack} onOpen={setOpenId} />
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
      <span className="notif-card__icon"><MaterialIcon name="notifications" size={22} /></span>
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
          <h2 className="notif-detail__title">{state.detail.title ?? ""}</h2>
          {formatPublishedAt(state.detail.published_at) && (
            <div className="notif-detail__date">{formatPublishedAt(state.detail.published_at)}</div>
          )}
          {/* Plain text; line breaks kept by white-space: pre-wrap. */}
          <div className="notif-detail__body">{state.detail.body ?? state.detail.preview ?? ""}</div>
          {state.detail.action === "plans" && (
            <button type="button" className="notif-detail__plans" onClick={onOpenPlans}>
              {t("notification_open_plans")}
            </button>
          )}
        </ScrollEdgeAffordance>
      )}
    </div>
  );
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
        <button type="button" className="notif-message__action" onClick={onAction}>
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
