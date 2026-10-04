import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getSavedLang, t } from "../i18n";
import {
  deleteSpeedTestHistoryEntry,
  downloadColor,
  pingColor,
  useSpeedTestHistory,
  type SpeedTestHistoryEntry,
} from "../session/speedTest";
import MaterialIcon from "../components/MaterialIcon";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import "./SpeedTestScreen.css";
import "./SpeedTestHistoryScreen.css";

// Same layout as the Android client's SpeedTestHistoryScreen: newest first,
// stored only on this device, swipe a row left to delete it.
export default function SpeedTestHistoryScreen({ onBack }: { onBack: () => void }) {
  const history = useSpeedTestHistory();

  return (
    <div className="speed-root">
      <div className="speed-topbar">
        <button className="speed-topbar__back" onClick={onBack} aria-label={t("back")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="speed-topbar__title">{t("speed_history_title")}</span>
      </div>

      <div className="speed-history-header">
        <span className="speed-history-header__icon">
          <MaterialIcon name="history" size={22} />
        </span>
        <div className="speed-history-header__text">
          <span className="speed-history-header__title">{t("speed_history_title")}</span>
          <span className="speed-history-header__hint">{t("speed_history_local_hint")}</span>
        </div>
        {history.length > 0 && <span className="speed-history-header__count">{history.length}</span>}
      </div>

      <ScrollEdgeAffordance className="speed-history-list" overlayFade>
        {history.length === 0 ? (
          <div className="speed-history-empty">{t("speed_history_empty")}</div>
        ) : (
          history.map((entry, index) => (
            <SwipeableHistoryEntry key={entry.timestampMillis} entry={entry} isLatest={index === 0} />
          ))
        )}
      </ScrollEdgeAffordance>
    </div>
  );
}

const DELETE_THRESHOLD = 0.35;
const DELETE_REVEAL_PX = 64;

function SwipeableHistoryEntry({ entry, isLatest }: { entry: SpeedTestHistoryEntry; isLatest: boolean }) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(false);
  // True from the first drag until the card has slid back. At rest the row
  // has no transform and no red layer: WebKitGTK composites transformed rows
  // separately and the list's fading-edge mask then cut them with a hard line.
  const [swiping, setSwiping] = useState(false);
  const dragRef = useRef<{ startX: number; width: number } | null>(null);

  const remove = () => {
    setRemoving(true);
    window.setTimeout(() => deleteSpeedTestHistoryEntry(entry.timestampMillis), 220);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || removing) return;
    dragRef.current = { startX: event.clientX, width: event.currentTarget.offsetWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setSwiping(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Only a leftward swipe deletes, as on the phone.
    setOffset(Math.min(0, event.clientX - drag.startX));
  };

  const onPointerEnd = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag) return;
    if (-offset >= drag.width * DELETE_THRESHOLD) {
      setOffset(-drag.width);
      remove();
    } else {
      setOffset(0);
      if (offset === 0) setSwiping(false);
    }
  };

  const reveal = Math.min(-offset / DELETE_REVEAL_PX, 1);

  return (
    <div className={`speed-history-row ${removing ? "speed-history-row--removing" : ""}`}>
      {(swiping || removing) && (
      <div className="speed-history-row__delete" aria-hidden="true">
        <span
          className="speed-history-row__delete-icon"
          style={{
            opacity: reveal,
            transform: `translateX(${14 - -offset / 2}px) scale(${0.55 + reveal * 0.45}) rotate(${12 * (1 - reveal)}deg)`,
          }}
        >
          <MaterialIcon name="deleteOutline" size={28} />
        </span>
      </div>
      )}
      <div
        className="speed-history-row__card"
        style={swiping || removing ? {
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 220ms cubic-bezier(0.4, 0, 0.2, 1)",
        } : undefined}
        onTransitionEnd={(event) => {
          if (event.propertyName === "transform" && offset === 0 && !dragging) setSwiping(false);
        }}
        tabIndex={0}
        aria-label={t("speed_history_delete")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") remove();
        }}
      >
        <HistoryEntryCard entry={entry} isLatest={isLatest} />
      </div>
    </div>
  );
}

function HistoryEntryCard({ entry, isLatest }: { entry: SpeedTestHistoryEntry; isLatest: boolean }) {
  const locale = getSavedLang() === "ru" ? "ru-RU" : "en-US";
  const date = new Date(entry.timestampMillis);
  const day = date.toLocaleDateString(locale, { day: "2-digit", month: "short" }).replace(".", "");
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const routeLabel = entry.viaVpn ? t("speed_via_vpn") : t("speed_direct");

  return (
    <div
      className={`speed-history-card ${isLatest ? "speed-history-card--latest" : ""} ${
        entry.viaVpn ? "speed-history-card--vpn" : "speed-history-card--direct"
      }`}
    >
      <span className="speed-history-card__icon">
        <MaterialIcon name={entry.viaVpn ? "lock" : "public"} size={23} />
      </span>
      <div className="speed-history-card__main">
        <div className="speed-history-card__speed">
          <span style={{ color: downloadColor(entry.downloadMbps) }}>
            {entry.downloadMbps.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          </span>
          <span className="speed-history-card__unit">{t("speed_unit_mbps")}</span>
        </div>
        <span className="speed-history-card__meta">{`${day} · ${time} · ${routeLabel}`}</span>
      </div>
      <div className="speed-history-card__ping">
        <span className="speed-history-card__ping-value" style={{ color: pingColor(entry.pingMs) }}>
          <MaterialIcon name="bolt" size={17} />
          {entry.pingMs}
        </span>
        <span className="speed-history-card__unit">{t("speed_unit_ms")}</span>
      </div>
    </div>
  );
}
