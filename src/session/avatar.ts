// Session-scoped cache for the user's Telegram avatar. The backend endpoint
// (GET /api/user/avatar) is rate-limited, so we fetch the JPEG at most once
// per app run, hold it as an object URL, and hand the same URL to every
// screen that needs it (currently the Settings account card).
import { fetchUserAvatar } from "../api/client";

let cachedUrl: string | null = null;
let inFlight: Promise<string | null> | null = null;

export async function getUserAvatarUrl(): Promise<string | null> {
  if (cachedUrl) return cachedUrl;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const blob = await fetchUserAvatar();
      if (!blob) return null;
      cachedUrl = URL.createObjectURL(blob);
      return cachedUrl;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function clearUserAvatarCache(): void {
  if (cachedUrl) {
    URL.revokeObjectURL(cachedUrl);
    cachedUrl = null;
  }
}
