// Session-scoped cache for the user's Telegram avatar. The backend endpoint
// (GET /api/user/avatar) is rate-limited, so we fetch the JPEG at most once
// per app run, hold it as an object URL, and hand the same URL to every
// screen that needs it (currently the Settings account card).
import { fetchUserAvatar } from "../api/client";
import { getSession } from "./store";

let cachedUrl: string | null = null;
let cachedKey: string | null = null;
let inFlight: { key: string; promise: Promise<string | null> } | null = null;
let cacheGeneration = 0;

function accountKey(): string | null {
  const session = getSession();
  if (!session.isLinked || session.telegramId === null) return null;
  return JSON.stringify([
    session.deviceId,
    session.telegramId,
    session.shortUuid ?? "",
    session.panelUserUuid ?? "",
  ]);
}

function revokeCachedUrl(): void {
  if (cachedUrl) URL.revokeObjectURL(cachedUrl);
  cachedUrl = null;
  cachedKey = null;
}

export async function getUserAvatarUrl(): Promise<string | null> {
  const key = accountKey();
  if (!key) return null;
  if (cachedKey !== null && cachedKey !== key) {
    cacheGeneration += 1;
    revokeCachedUrl();
  }
  // cachedUrl === null is also a valid, successfully fetched "no avatar"
  // result. cachedKey distinguishes it from a cache miss.
  if (cachedKey === key) return cachedUrl;
  if (inFlight?.key === key) return inFlight.promise;
  const generation = cacheGeneration;
  let promise!: Promise<string | null>;
  promise = (async () => {
    try {
      const blob = await fetchUserAvatar();
      if (generation !== cacheGeneration || accountKey() !== key) return null;
      if (!blob) {
        revokeCachedUrl();
        cachedKey = key;
        return null;
      }
      const nextUrl = URL.createObjectURL(blob);
      if (generation !== cacheGeneration || accountKey() !== key) {
        URL.revokeObjectURL(nextUrl);
        return null;
      }
      revokeCachedUrl();
      cachedUrl = nextUrl;
      cachedKey = key;
      return cachedUrl;
    } catch {
      return null;
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  })();
  inFlight = { key, promise };
  return promise;
}

export function clearUserAvatarCache(): void {
  cacheGeneration += 1;
  inFlight = null;
  revokeCachedUrl();
}
