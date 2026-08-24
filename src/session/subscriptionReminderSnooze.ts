const STORAGE_KEY = "tobevpn_subscription_reminder_snooze_v1";
const SUBSCRIPTION_REMINDER_SNOOZE_MS = 12 * 60 * 60 * 1000;

export interface SubscriptionReminderSnooze {
  untilMillis: number;
  expiresAtMillis: number | null;
}

function safeEpochMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Matches Android: 12 hours, but never beyond an active subscription expiry. */
export function subscriptionReminderSnoozeUntil(
  nowMillis: number,
  expiresAtMillis: number | null,
): number {
  const regularSnoozeUntil = nowMillis + SUBSCRIPTION_REMINDER_SNOOZE_MS;
  return expiresAtMillis !== null && expiresAtMillis > nowMillis
    ? Math.min(regularSnoozeUntil, expiresAtMillis)
    : regularSnoozeUntil;
}

/** A renewed/changed expiry invalidates the old snooze immediately. */
export function isSubscriptionReminderSnoozed(
  snooze: SubscriptionReminderSnooze,
  currentExpiryMillis: number | null,
  nowMillis: number,
): boolean {
  return snooze.untilMillis > nowMillis &&
    snooze.expiresAtMillis === currentExpiryMillis;
}

export function readSubscriptionReminderSnooze(): SubscriptionReminderSnooze {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { untilMillis: 0, expiresAtMillis: null };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const untilMillis = safeEpochMillis(parsed.untilMillis);
    const rawExpiry = parsed.expiresAtMillis;
    const expiresAtMillis = rawExpiry === null ? null : safeEpochMillis(rawExpiry);
    if (untilMillis === null || (rawExpiry !== null && expiresAtMillis === null)) {
      localStorage.removeItem(STORAGE_KEY);
      return { untilMillis: 0, expiresAtMillis: null };
    }
    return { untilMillis, expiresAtMillis };
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is optional; the in-memory fallback below still works.
    }
    return { untilMillis: 0, expiresAtMillis: null };
  }
}

export function snoozeSubscriptionReminder(
  expiresAtMillis: number | null,
  nowMillis = Date.now(),
): SubscriptionReminderSnooze {
  const snooze = {
    untilMillis: subscriptionReminderSnoozeUntil(nowMillis, expiresAtMillis),
    expiresAtMillis,
  } satisfies SubscriptionReminderSnooze;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snooze));
  } catch {
    // Keep the current app session snoozed even when storage is unavailable.
  }
  return snooze;
}
