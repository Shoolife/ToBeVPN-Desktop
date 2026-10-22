// Server-side limit on failed referrer assignments (POST /api/device/referrer
// answers 429 with Retry-After). The limit belongs to the Telegram account and
// survives restarts and token refreshes, so the end of the window is kept in
// localStorage, scoped to the Telegram ID it was recorded for.
const STORAGE_KEY = "tobevpn:referrer-limit:v1";

interface StoredLimit {
  telegramId: string;
  until: number;
}

export function getReferrerLimitUntil(telegramId: number | null | undefined): number | null {
  if (telegramId == null) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredLimit;
    if (stored.telegramId !== String(telegramId)) return null;
    return typeof stored.until === "number" && stored.until > Date.now() ? stored.until : null;
  } catch {
    return null;
  }
}

export function setReferrerLimitUntil(telegramId: number | null | undefined, until: number): void {
  if (telegramId == null) return;
  try {
    const stored: StoredLimit = { telegramId: String(telegramId), until };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable: the in-memory state still pauses this screen.
  }
}

// Seconds to wait from a Retry-After header: delta-seconds (what the referrer
// endpoint sends) or an HTTP date. Null when absent or unreadable.
export function parseRetryAfterSeconds(value: string | null | undefined, nowMs: number): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (/^-?\d+$/.test(text)) return Math.max(0, Number.parseInt(text, 10));
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.floor((date - nowMs) / 1000));
}
