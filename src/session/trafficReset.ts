import { getSavedLang, t, tf } from "../i18n";

// The next traffic limit reset (current-plan next_traffic_reset_at), worded
// the same on the home card, in the subscription sheet and in notifications.

export interface TrafficResetText {
  /** "15 окт." / "завтра" / "в 03:10": fits the narrow column on the home card. */
  when: string;
  /** "Лимит трафика обновится 15 октября в 03:10". */
  full: string;
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
  const full = tf(
    "traffic_reset_full",
    reset.toLocaleString(locale, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }),
  );
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(reset) - startOfDay(new Date(now))) / 86_400_000);
  const when =
    days <= 0
      ? tf("traffic_reset_when_today", time)
      : days === 1
        ? t("traffic_reset_when_tomorrow")
        : reset.toLocaleDateString(locale, { day: "numeric", month: "short" });
  return { when, full };
}
