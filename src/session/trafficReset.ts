import { getSavedLang, t, tf } from "../i18n";

// The next traffic limit reset (current-plan next_traffic_reset_at), worded
// the same on the home card, in the subscription sheet and in notifications.

export interface TrafficResetText {
  /** "03.11.2026" / "завтра" / "в 05:10": under the bar on the home card. */
  when: string;
  /** "Сброс трафика 03.11 в 05:10": tooltip and notifications. */
  full: string;
  /** "Сброс 03.11 в 05:10": the chip in the plan card without limits. */
  chip: string;
  /** "03.11 в 05:10": under the traffic limit in the plan card. */
  dateTime: string;
}

/** Null when there is no limit, no reset date, or the date is already past
 *  (stale until the next plan refresh). */
export function trafficResetText(
  resetAt: number | null,
  limitBytes: number,
  now = Date.now(),
): TrafficResetText | null {
  if (resetAt === null || !(limitBytes > 0) || resetAt <= now) return null;
  const locale = getSavedLang() === "ru" ? "ru-RU" : "en-US";
  const reset = new Date(resetAt);
  const time = reset.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const shortDate =
    locale === "ru-RU"
      ? `${String(reset.getDate()).padStart(2, "0")}.${String(reset.getMonth() + 1).padStart(2, "0")}`
      : reset.toLocaleDateString(locale, { day: "numeric", month: "short" });
  // The home card shows the year, like the plan expiry "до 01.06.2027".
  const dateWithYear =
    locale === "ru-RU"
      ? `${shortDate}.${reset.getFullYear()}`
      : reset.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  const full = tf("traffic_reset_full", shortDate, time);
  const chip = tf("traffic_reset_chip", shortDate, time);
  const dateTime = tf("traffic_reset_datetime", shortDate, time);
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(reset) - startOfDay(new Date(now))) / 86_400_000);
  const when =
    days <= 0
      ? tf("traffic_reset_when_today", time)
      : days === 1
        ? t("traffic_reset_when_tomorrow")
        : dateWithYear;
  return { when, full, chip, dateTime };
}
