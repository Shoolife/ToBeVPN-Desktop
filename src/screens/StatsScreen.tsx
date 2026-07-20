import { useState, useEffect } from "react";
import { t, getSavedLang } from "../i18n";
import { getDayStats, getWeekStats, getMonthStats, type StatSlot } from "../session/stats";
import "./StatsScreen.css";

type Period = "day" | "week" | "month";

function formatBytes(bytes: number): string {
  const isRu = getSavedLang() === "ru";
  const kb = isRu ? "КБ" : "KB";
  const mb = isRu ? "МБ" : "MB";
  const gb = isRu ? "ГБ" : "GB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${kb}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${mb}`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ${gb}`;
}

function shortBytes(bytes: number): string {
  if (bytes <= 0) return "0";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024))}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function formatTime(seconds: number): string {
  const isRu = getSavedLang() === "ru";
  const hUnit = isRu ? "ч" : "h";
  const mUnit = isRu ? "м" : "m";
  const sUnit = isRu ? "с" : "s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}${hUnit} ${m}${mUnit}`;
  if (m > 0) return `${m}${mUnit}`;
  return `${seconds}${sUnit}`;
}

function formatSlotLabel(epochSeconds: number, period: Period, index: number): string {
  const date = new Date(epochSeconds * 1000);
  const lang = getSavedLang();
  switch (period) {
    case "day": {
      const hour = date.getHours();
      return hour % 3 === 0 ? `${hour}:00` : "";
    }
    case "week": {
      const dayName = date.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US", { weekday: "short" });
      return dayName.charAt(0).toUpperCase() + dayName.slice(1);
    }
    case "month":
      return `${t("stats_week_short")} ${index + 1}`;
  }
}

function formatRowLabel(epochSeconds: number, period: Period): string {
  const date = new Date(epochSeconds * 1000);
  const lang = getSavedLang();
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  switch (period) {
    case "day":
      return `${date.getHours().toString().padStart(2, "0")}:00`;
    case "week": {
      const name = date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "short" });
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    case "month": {
      const start = date.toLocaleDateString(locale, { day: "numeric", month: "short" });
      const end = new Date((epochSeconds + 6 * 86400) * 1000).toLocaleDateString(locale, { day: "numeric", month: "short" });
      return `${start} — ${end}`;
    }
  }
}

export default function StatsScreen({ onBack }: { onBack: () => void }) {
  const [period, setPeriod] = useState<Period>("day");
  const [stats, setStats] = useState<StatSlot[]>([]);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    setAnimated(false);
    switch (period) {
      case "day": setStats(getDayStats()); break;
      case "week": setStats(getWeekStats()); break;
      case "month": setStats(getMonthStats()); break;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimated(true));
    });
  }, [period]);

  const totalBytes = stats.reduce((s, st) => s + st.totalBytes, 0);
  const totalSessions = stats.reduce((s, st) => s + st.sessions, 0);
  const totalSeconds = stats.reduce((s, st) => s + st.totalSeconds, 0);
  const avgPerSession = totalSessions > 0 ? Math.floor(totalBytes / totalSessions) : 0;

  const maxBytes = Math.max(...stats.map((s) => s.totalBytes), 1);
  const maxIndex = stats.findIndex((s) => s.totalBytes === maxBytes && maxBytes > 0);

  const nonZeroStats = stats.filter((s) => s.totalBytes > 0);
  const maxRowBytes = nonZeroStats.length > 0 ? Math.max(...nonZeroStats.map((s) => s.totalBytes)) : 1;

  const periodLabel =
    period === "day" ? t("stats_today_by_hour")
    : period === "week" ? t("stats_week_by_day")
    : t("stats_month_by_week");

  return (
    <div className="stats-root">
      <div className="stats-topbar">
        <button className="stats-topbar__back" onClick={onBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="stats-topbar__title">{t("stats_title")}</span>
      </div>

      <div className="stats-content">
        {/* Hero card */}
        <div className="stats-hero">
          <div className="stats-hero__top">
            <div className="stats-hero__icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <div>
              <div className="stats-hero__label">{t("stats_total_used")}</div>
              <div className="stats-hero__sublabel">{t("stats_your_stats")}</div>
            </div>
          </div>
          <div className="stats-hero__total">{formatBytes(totalBytes)}</div>
          <div className="stats-hero__metrics">
            <div className="stats-hero__metric">
              <svg className="stats-hero__metric-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              <span className="stats-hero__metric-value">{totalSessions}</span>
              <span className="stats-hero__metric-label">{t("stats_metric_sessions")}</span>
            </div>
            <div className="stats-hero__divider" />
            <div className="stats-hero__metric">
              <svg className="stats-hero__metric-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span className="stats-hero__metric-value">{formatTime(totalSeconds)}</span>
              <span className="stats-hero__metric-label">{t("stats_metric_time")}</span>
            </div>
            <div className="stats-hero__divider" />
            <div className="stats-hero__metric">
              <svg className="stats-hero__metric-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span className="stats-hero__metric-value">{formatBytes(avgPerSession)}</span>
              <span className="stats-hero__metric-label">{t("stats_metric_avg")}</span>
            </div>
          </div>
        </div>

        {/* Period selector */}
        <div className="stats-periods">
          {(["day", "week", "month"] as Period[]).map((p) => (
            <button
              key={p}
              className={`stats-period-chip ${period === p ? "stats-period-chip--active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "day" ? t("stats_period_day") : p === "week" ? t("stats_period_week") : t("stats_period_month")}
            </button>
          ))}
        </div>

        {/* Chart */}
        <div className="stats-chart">
          <div className="stats-chart__y-axis">
            <span className="stats-chart__y-label">{shortBytes(maxBytes)}</span>
            <span className="stats-chart__y-label">{shortBytes(Math.floor(maxBytes / 2))}</span>
            <span className="stats-chart__y-label">0</span>
          </div>
          <div className="stats-chart__area">
            <div className="stats-chart__gridlines">
              <div className="stats-chart__gridline" />
              <div className="stats-chart__gridline" />
              <div className="stats-chart__gridline" />
            </div>
            <div className="stats-chart__bars">
              {stats.map((slot, i) => {
                const frac = slot.totalBytes / maxBytes;
                const label = formatSlotLabel(slot.period, period, i);
                const isMax = i === maxIndex && maxBytes > 0;
                return (
                  <div key={i} className="stats-chart__bar-wrapper">
                    <div
                      className={`stats-chart__bar ${isMax ? "stats-chart__bar--max" : ""}`}
                      style={{ height: animated ? `${Math.max(frac * 100, frac > 0 ? 2 : 0)}%` : "0%" }}
                    >
                      {label && <span className="stats-chart__bar-label">{label}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Period label */}
        <div className="stats-section-title">{periodLabel}</div>

        {/* Stat rows */}
        {nonZeroStats.map((stat, i) => {
          const fraction = stat.totalBytes / maxRowBytes;
          return (
            <div key={i} className="stats-row">
              <div className="stats-row__top">
                <span className="stats-row__period">{formatRowLabel(stat.period, period)}</span>
                <span className="stats-row__bytes">{formatBytes(stat.totalBytes)}</span>
              </div>
              <div className="stats-row__detail">
                {stat.sessions} {t("stats_sessions_short")}  &bull;  {formatTime(stat.totalSeconds)}
              </div>
              <div className="stats-row__bar-bg">
                <div className="stats-row__bar-fill" style={{ width: `${fraction * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
