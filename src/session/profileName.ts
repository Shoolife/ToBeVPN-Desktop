// Session-scoped cache for the user's Telegram profile (name + @username).
// The bot stores it in the panel user's `description` field as
// "name: <full name>\nusername: <handle>" (same convention the Android client
// parses). Fetched once per app run and shown under the account-card avatar.
import { getUserByTelegramId } from "../api/client";
import { getSession, type Session } from "./store";

export interface TelegramProfile {
  name: string | null;
  username: string | null;
}

let cached: TelegramProfile | null = null;
let cachedKey: string | null = null;
let inFlight: { key: string; promise: Promise<TelegramProfile> } | null = null;
let cacheGeneration = 0;

const EMPTY: TelegramProfile = { name: null, username: null };

function accountKey(session: Session): string | null {
  if (!session.isLinked || session.telegramId === null) return null;
  return JSON.stringify([
    session.deviceId,
    session.telegramId,
    session.shortUuid ?? "",
    session.panelUserUuid ?? "",
  ]);
}

function profileValue(value: string, maxLength: number): string | null {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function parseTelegramProfile(description: unknown): TelegramProfile {
  if (typeof description !== "string" || !description) return { ...EMPTY };
  let name: string | null = null;
  let username: string | null = null;
  for (const rawLine of description.slice(0, 4_096).split(/\r?\n/)) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();
    if (lower.startsWith("name:")) {
      name = profileValue(line.slice(line.indexOf(":") + 1), 128);
    } else if (lower.startsWith("username:")) {
      const value = profileValue(line.slice(line.indexOf(":") + 1), 65)?.replace(/^@/, "") ?? null;
      username = value && value.length <= 64 && /^[A-Za-z0-9_]+$/.test(value)
        ? value
        : null;
    }
  }
  return { name, username };
}

export async function getUserProfile(): Promise<TelegramProfile> {
  const session = getSession();
  const key = accountKey(session);
  if (key === null || session.telegramId === null) return { ...EMPTY };
  const telegramId = session.telegramId;
  if (cachedKey !== null && cachedKey !== key) {
    cacheGeneration += 1;
    cached = null;
    cachedKey = null;
  }
  if (cached && cachedKey === key) return cached;
  if (inFlight?.key === key) return inFlight.promise;
  const generation = cacheGeneration;
  let promise!: Promise<TelegramProfile>;
  promise = (async () => {
    try {
      const { response: users } = await getUserByTelegramId(telegramId);
      if (generation !== cacheGeneration || accountKey(getSession()) !== key) {
        return { ...EMPTY };
      }
      for (const user of users) {
        const parsed = parseTelegramProfile(user.description);
        if (parsed.name || parsed.username) {
          cached = parsed;
          cachedKey = key;
          return parsed;
        }
      }
      // An empty successful response is a valid result. Cache it so opening
      // Settings repeatedly does not hammer the same rate-limited endpoint.
      cached = { ...EMPTY };
      cachedKey = key;
      return cached;
    } catch {
      return { ...EMPTY };
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  })();
  inFlight = { key, promise };
  return promise;
}

export function clearUserProfileCache(): void {
  cacheGeneration += 1;
  cached = null;
  cachedKey = null;
  inFlight = null;
}
