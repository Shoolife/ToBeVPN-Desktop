// Session-scoped cache for the user's Telegram avatar. The backend endpoint
// (GET /api/user/avatar) is rate-limited, so we share one request/result per
// account and app run (with one bounded retry after a transient failure), hold
// the JPEG as an object URL, and hand it to every screen that needs it.
import { fetchUserAvatar } from "../api/client";
import { getSession } from "./store";

let cachedUrl: string | null = null;
let cachedKey: string | null = null;
let inFlight: { key: string; promise: Promise<string | null> } | null = null;
let cacheGeneration = 0;

function accountKey(): string | null {
  const session = getSession();
  if (!session.isLinked || session.telegramId === null) return null;
  // shortUuid/panelUserUuid are filled asynchronously by subscription sync.
  // They describe the same Telegram account, so including them here changed
  // the key in the middle of an avatar request and could start a second,
  // rate-limited download.  Device + Telegram identity is the stable scope.
  return JSON.stringify([session.deviceId, session.telegramId]);
}

const AVATAR_RETRY_DELAY_MS = 900;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchAvatarWithOneRetry(
  generation: number,
  key: string,
): Promise<Blob | null> {
  try {
    return await fetchUserAvatar();
  } catch {
    // Do not turn one temporary network/auth/gateway failure into a blank
    // avatar for the rest of the screen lifetime.  One bounded retry is well
    // below the endpoint's rate limit and does not loop in the background.
    await delay(AVATAR_RETRY_DELAY_MS);
    if (generation !== cacheGeneration || accountKey() !== key) return null;
    return fetchUserAvatar();
  }
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
  if (cachedKey === key) return cachedUrl;
  if (inFlight?.key === key) return inFlight.promise;
  const generation = cacheGeneration;
  let promise!: Promise<string | null>;
  promise = (async () => {
    try {
      const blob = await fetchAvatarWithOneRetry(generation, key);
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
