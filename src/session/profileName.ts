// Session-scoped cache for the user's Telegram profile (name + @username).
// The bot stores it in the panel user's `description` field as
// "name: <full name>\nusername: <handle>" (same convention the Android client
// parses). Fetched once per app run and shown under the account-card avatar.
import { getUserByTelegramId } from "../api/client";
import { getSession } from "./store";

export interface TelegramProfile {
  name: string | null;
  username: string | null;
}

let cached: TelegramProfile | null = null;
let inFlight: Promise<TelegramProfile> | null = null;

const EMPTY: TelegramProfile = { name: null, username: null };

function parseTelegramProfile(description?: string | null): TelegramProfile {
  if (!description) return { ...EMPTY };
  let name: string | null = null;
  let username: string | null = null;
  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();
    if (lower.startsWith("name:")) {
      const value = line.slice(line.indexOf(":") + 1).trim();
      if (value) name = value;
    } else if (lower.startsWith("username:")) {
      const value = line.slice(line.indexOf(":") + 1).trim().replace(/^@/, "");
      if (value) username = value;
    }
  }
  return { name, username };
}

export async function getUserProfile(): Promise<TelegramProfile> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  const session = getSession();
  if (!session.isLinked || session.telegramId === null) return { ...EMPTY };
  const telegramId = session.telegramId;
  inFlight = (async () => {
    try {
      const { response: users } = await getUserByTelegramId(telegramId);
      for (const user of users) {
        const parsed = parseTelegramProfile(user.description);
        if (parsed.name || parsed.username) {
          cached = parsed;
          return parsed;
        }
      }
      return { ...EMPTY };
    } catch {
      return { ...EMPTY };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function clearUserProfileCache(): void {
  cached = null;
}
