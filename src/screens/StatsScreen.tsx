import { useState, useEffect, useRef, type CSSProperties } from "react";
import FadeText from "../components/FadeText";
import { formatDecimal, t, getSavedLang } from "../i18n";
import {
  getDayStats,
  getWeekStats,
  getMonthStats,
  subscribeStats,
  periodRanges,
  type StatSlot,
} from "../session/stats";
import { routerTrafficBetween } from "../session/router";
import { useRouterTraffic } from "../session/useRouterTraffic";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import "./StatsScreen.css";

type Period = "day" | "week" | "month";

function formatBytes(bytes: number): string {
  const isRu = getSavedLang() === "ru";
  const kb = isRu ? "КБ" : "KB";
  const mb = isRu ? "МБ" : "MB";
  const gb = isRu ? "ГБ" : "GB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatDecimal(bytes / 1024, 1)} ${kb}`;
  if (bytes < 1024 * 1024 * 1024) return `${formatDecimal(bytes / (1024 * 1024), 1)} ${mb}`;
  return `${formatDecimal(bytes / (1024 * 1024 * 1024), 2)} ${gb}`;
}

function shortBytes(bytes: number): string {
  if (bytes <= 0) return "0";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024))}M`;
  return `${formatDecimal(bytes / (1024 * 1024 * 1024), 1)}G`;
}

function formatTime(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const isRu = getSavedLang() === "ru";
  const hUnit = isRu ? "ч" : "h";
  const mUnit = isRu ? "м" : "m";
  const sUnit = isRu ? "с" : "s";
  const h = Math.floor(wholeSeconds / 3600);
  const m = Math.floor((wholeSeconds % 3600) / 60);
  if (h > 0) return `${h}${hUnit} ${m}${mUnit}`;
  if (m > 0) return `${m}${mUnit}`;
  return `${wholeSeconds}${sUnit}`;
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
      // The final slot is a partial week — cap the shown end at the last day
      // of the month so it never reads "29 Jul — 4 Aug".
      const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const rawEnd = new Date(date);
      rawEnd.setDate(date.getDate() + 6);
      const cappedEnd = rawEnd.getTime() > lastDayOfMonth.getTime() ? lastDayOfMonth : rawEnd;
      const end = cappedEnd.toLocaleDateString(locale, { day: "numeric", month: "short" });
      return `${start} — ${end}`;
    }
  }
}

/** The Router screen's crossfade timing, as on the phone. */
const SECTION_FADE_OUT_MS = 220;
const SECTION_FADE_IN_MS = 420;
const SECTION_FADE_IN_DELAY_MS = 60;

export default function StatsScreen({ onBack }: { onBack: () => void }) {
  // The chip follows a tap at once; the chart and rows below change to the
  // new period after the old ones faded out, then fade in with their data
  // (as on the phone): never a new period's labels over the old bars.
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("day");
  const [period, setPeriod] = useState<Period>("day");
  const [sectionVisible, setSectionVisible] = useState(true);
  useEffect(() => {
    if (selectedPeriod === period) {
      setSectionVisible(true);
      return;
    }
    setSectionVisible(false);
    const timer = window.setTimeout(() => {
      setPeriod(selectedPeriod);
      setSectionVisible(true);
    }, SECTION_FADE_OUT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeriod]);
  const [stats, setStats] = useState<StatSlot[]>([]);
  const [animated, setAnimated] = useState(false);
  // The bar under the mouse: its traffic shows above the chart, as on the
  // Router screen.
  const [hovered, setHovered] = useState<number | null>(null);
  // The bar clicked last: the list scrolls to its row and lights it up (as
  // on the phone). Another period clears it.
  const [picked, setPicked] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => setPicked(null), [period]);
  const pickSlot = (index: number) => {
    const row = rowRefs.current.get(index);
    if (!row) return;
    setPicked(index);
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  useEffect(() => {
    setAnimated(false);
    const refresh = () => {
      switch (period) {
        case "day": setStats(getDayStats()); break;
        case "week": setStats(getWeekStats()); break;
        case "month": setStats(getMonthStats()); break;
      }
    };
    refresh();
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => setAnimated(true));
    });
    const unsubscribe = subscribeStats(refresh);
    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
      unsubscribe();
    };
  }, [period]);

  // With a linked router, its traffic (the whole home network) joins this
  // computer's in the total, the chart and the rows; without one the screen
  // is unchanged.
  const routerTraffic = useRouterTraffic(60_000);
  const withRouter = routerTraffic.linked;
  const routerSlots = withRouter
    ? periodRanges(period).map(([start, end]) => routerTrafficBetween(routerTraffic.hours, start, end))
    : [];
  const routerAt = (index: number) => routerSlots[index] ?? 0;
  const routerTotal = routerSlots.reduce((sum, bytes) => sum + bytes, 0);
  const computerBytes = stats.reduce((s, st) => s + st.totalBytes, 0);
  const totalBytes = computerBytes + routerTotal;
  const totalSessions = stats.reduce((s, st) => s + st.sessions, 0);
  const totalSeconds = stats.reduce((s, st) => s + st.totalSeconds, 0);
  const avgPerSession = totalSessions > 0 ? Math.floor(computerBytes / totalSessions) : 0;


  const slotBytes = stats.map((s, i) => s.totalBytes + routerAt(i));
  const maxBytes = Math.max(...slotBytes, 1);
  const maxIndex = slotBytes.findIndex((bytes) => bytes === maxBytes && maxBytes > 0);

  const nonZeroStats = stats
    .map((stat, index) => ({ stat, index, router: routerAt(index), bytes: slotBytes[index] }))
    .filter((row) => row.bytes > 0);
  const maxRowBytes = nonZeroStats.length > 0 ? Math.max(...nonZeroStats.map((row) => row.bytes)) : 1;

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

      <ScrollEdgeAffordance className="stats-content">
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
          <div className={`stats-hero__total ${withRouter ? "stats-hero__total--split" : ""}`}><FadeText fadeKey={period} text={formatBytes(totalBytes)} /></div>
          {withRouter && (
            <div className="stats-hero__split">
              <span className="stats-hero__split-item">
                <span className="stats-legend__dot" />
                <FadeText fadeKey={period} text={`${t("stats_this_computer")} ${formatBytes(computerBytes)}`} />
              </span>
              <span className="stats-hero__split-item">
                <span className="stats-legend__dot stats-legend__dot--router" />
                <FadeText fadeKey={period} text={`${t("stats_router_title")} ${formatBytes(routerTotal)}`} />
              </span>
            </div>
          )}
          <div className="stats-hero__metrics">
            <div className="stats-hero__metric">
              <svg className="stats-hero__metric-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              <span className="stats-hero__metric-value"><FadeText fadeKey={period} text={String(totalSessions)} /></span>
              <span className="stats-hero__metric-label">{t("stats_metric_sessions")}</span>
            </div>
            <div className="stats-hero__divider" />
            <div className="stats-hero__metric">
              <svg className="stats-hero__metric-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span className="stats-hero__metric-value"><FadeText fadeKey={period} text={formatTime(totalSeconds)} /></span>
              <span className="stats-hero__metric-label">{t("stats_metric_time")}</span>
            </div>
            <div className="stats-hero__divider" />
            <div className="stats-hero__metric">
              <svg className="stats-hero__metric-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span className="stats-hero__metric-value"><FadeText fadeKey={period} text={formatBytes(avgPerSession)} /></span>
              <span className="stats-hero__metric-label">{t("stats_metric_avg")}</span>
            </div>
          </div>
        </div>

        {/* Period selector */}
        <div className="stats-periods">
          {(["day", "week", "month"] as Period[]).map((p) => (
            <button
              key={p}
              className={`stats-period-chip ${selectedPeriod === p ? "stats-period-chip--active" : ""}`}
              onClick={() => setSelectedPeriod(p)}
            >
              {p === "day" ? t("stats_period_day") : p === "week" ? t("stats_period_week") : t("stats_period_month")}
            </button>
          ))}
        </div>

        {/* Faded with a cover in the background's colour (the refresh swap's),
            not its own opacity, which WebKitGTK draws badly over animated parts. */}
        <div
          className="refresh-swap"
          style={{
            ["--refresh-swap-cover" as string]: sectionVisible ? 0 : 1,
            // The old period's bars cannot be hovered while they fade out.
            pointerEvents: sectionVisible ? undefined : "none",
            ["--refresh-swap-transition" as string]: sectionVisible
              ? `opacity ${SECTION_FADE_IN_MS}ms cubic-bezier(0.4, 0, 0.2, 1) ${SECTION_FADE_IN_DELAY_MS}ms`
              : `opacity ${SECTION_FADE_OUT_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
          } as CSSProperties}
        >
        {withRouter && (
          <div className="stats-legend">
            <span className="stats-legend__item"><span className="stats-legend__dot" />{t("stats_this_computer")}</span>
            <span className="stats-legend__item"><span className="stats-legend__dot stats-legend__dot--router" />{t("stats_router_legend")}</span>
          </div>
        )}

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
            <div className="stats-chart__bars" onMouseLeave={() => setHovered(null)}>
              {hovered !== null && stats[hovered] && slotBytes[hovered] > 0 && (
                <span
                  className="stats-chart__tip"
                  style={{
                    left: `${((hovered + 0.5) / stats.length) * 100}%`,
                    // Kept inside the chart at both ends.
                    transform: `translateX(${hovered < 2 ? "-15%" : hovered > stats.length - 3 ? "-85%" : "-50%"})`,
                  }}
                  role="tooltip"
                >
                  <span className="stats-chart__tip-value">{formatBytes(slotBytes[hovered])}</span>
                  {withRouter && routerAt(hovered) > 0 && stats[hovered].totalBytes > 0 && (
                    <span className="stats-chart__tip-split">
                      {`${t("stats_this_computer")} ${formatBytes(stats[hovered].totalBytes)} · ${t("stats_router_short")} ${formatBytes(routerAt(hovered))}`}
                    </span>
                  )}
                  <span className="stats-chart__tip-time">{formatRowLabel(stats[hovered].period, period)}</span>
                </span>
              )}
              {stats.map((slot, i) => {
                const frac = slot.totalBytes / maxBytes;
                const routerFrac = routerAt(i) / maxBytes;
                const label = formatSlotLabel(slot.period, period, i);
                const isMax = i === maxIndex && maxBytes > 0;
                return (
                  <div
                    key={i}
                    className={`stats-chart__bar-wrapper ${hovered === i ? "stats-chart__bar-wrapper--hovered" : ""} ${picked === i ? "stats-chart__bar-wrapper--picked" : ""} ${slotBytes[i] > 0 ? "stats-chart__bar-wrapper--clickable" : ""}`}
                    onMouseEnter={() => setHovered(i)}
                    onClick={() => pickSlot(i)}
                  >
                    {withRouter && (
                      <div
                        className={`stats-chart__bar stats-chart__bar--router ${frac > 0 ? "stats-chart__bar--stacked" : ""}`}
                        style={{ height: animated ? `${Math.max(routerFrac * 100, routerFrac > 0 ? 2 : 0)}%` : "0%" }}
                      />
                    )}
                    <div
                      className={`stats-chart__bar ${isMax && !withRouter ? "stats-chart__bar--max" : ""} ${withRouter && routerFrac > 0 ? "stats-chart__bar--under" : ""}`}
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
        {nonZeroStats.map(({ stat, index, router, bytes }) => {
          const fraction = bytes / maxRowBytes;
          return (
            <div
              key={index}
              ref={(element) => {
                if (element) rowRefs.current.set(index, element);
                else rowRefs.current.delete(index);
              }}
              className={`stats-row ${picked === index ? "stats-row--picked" : ""}`}
            >
              <div className="stats-row__top">
                <span className="stats-row__period">{formatRowLabel(stat.period, period)}</span>
                <span className="stats-row__bytes">{formatBytes(bytes)}</span>
              </div>
              <div className="stats-row__detail">
                {[
                  stat.sessions > 0 || stat.totalSeconds > 0
                    ? `${stat.sessions} ${t("stats_sessions_short")}  \u2022  ${formatTime(stat.totalSeconds)}`
                    : null,
                  withRouter && router > 0 ? `${t("stats_router_short")} ${formatBytes(router)}` : null,
                ]
                  .filter(Boolean)
                  .join("  \u2022  ")}
              </div>
              <div className="stats-row__bar-bg">
                <div className="stats-row__bar-fill" style={{ width: `${fraction * 100}%` }} />
              </div>
            </div>
          );
        })}
        </div>
      </ScrollEdgeAffordance>
    </div>
  );
}
