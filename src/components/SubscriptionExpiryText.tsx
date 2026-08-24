import { formatDateDots } from "../session/dateFormat";

const SUBSCRIPTION_DAY_MS = 86_400_000;
const SUBSCRIPTION_CRITICAL_THRESHOLD_MS = 3 * SUBSCRIPTION_DAY_MS;
const SUBSCRIPTION_WARNING_THRESHOLD_MS = 7 * SUBSCRIPTION_DAY_MS;

export type SubscriptionExpiryUrgency = "normal" | "warning" | "critical";

/** Mirrors Android's shared subscription-expiry thresholds exactly. */
export function subscriptionExpiryUrgency(
  expiresAtMillis: number,
  nowMillis = Date.now(),
): SubscriptionExpiryUrgency {
  const millisLeft = expiresAtMillis - nowMillis;
  if (millisLeft <= SUBSCRIPTION_CRITICAL_THRESHOLD_MS) return "critical";
  if (millisLeft <= SUBSCRIPTION_WARNING_THRESHOLD_MS) return "warning";
  return "normal";
}

/**
 * Keeps the surrounding localized sentence neutral and accents only its date,
 * matching the phone UI. `text` must contain the same formatted expiry date;
 * callers normally build it with `tf(..., formatDateDots(expiresAt))`.
 */
export default function SubscriptionExpiryText({
  expiresAt,
  text,
}: {
  expiresAt: number;
  text?: string;
}) {
  const date = formatDateDots(expiresAt);
  const label = text ?? date;
  const dateStart = label.indexOf(date);
  if (dateStart < 0) return <>{label}</>;

  const urgency = subscriptionExpiryUrgency(expiresAt);
  const dateClass = urgency === "normal"
    ? "subscription-expiry-date"
    : `subscription-expiry-date subscription-expiry-date--${urgency}`;

  return (
    <>
      {label.slice(0, dateStart)}
      <span className={dateClass}>{date}</span>
      {label.slice(dateStart + date.length)}
    </>
  );
}
