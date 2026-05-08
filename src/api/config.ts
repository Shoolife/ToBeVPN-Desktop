// Bot backend configuration. Override via .env (VITE_BOT_API_URL).
//
// In dev mode Vite proxies /api/* to the real backend, so we use a relative URL.
// In production (Tauri webview with tauri:// origin) CORS is not enforced,
// so we use the full URL.
//
// SECURITY: We never hardcode the production domain into the public source —
// it would land in GitHub search results and get scraped/banned within
// hours. The build will hard-fail if VITE_BOT_API_URL is missing instead of
// silently shipping a build that points nowhere. Auth is per-device (bootstrap
// + access/refresh tokens). Never put auth secrets behind VITE_ — those get
// inlined into the JS bundle at build time and can be extracted by anyone
// who unpacks the .deb/.exe.
const isDev = import.meta.env.DEV;
const envUrl = (import.meta.env.VITE_BOT_API_URL ?? "").trim();
if (!isDev && !envUrl) {
  throw new Error(
    "VITE_BOT_API_URL is not set. Configure it in .env (local dev) or in CI secrets.",
  );
}
const fullUrl = envUrl.endsWith("/") ? envUrl : envUrl + "/";
export const BOT_API_BASE_URL = isDev ? "/" : fullUrl;

// Optional bot-API fallback. Empty in dev (Vite proxies /api/*); only used
// in production when the primary BOT_API_BASE_URL request fails. The
// configured value is a bare hostname (e.g. "gateway.example.invalid")
// that mirrors the primary backend's API surface 1:1 — the client just
// swaps the host of the original request, keeping path / query / body /
// headers verbatim.
const fallbackBot = (import.meta.env.VITE_FALLBACK_BOT_DOMAIN ?? "").trim();
export const BOT_API_FALLBACK_URL: string | null =
  !isDev && fallbackBot ? fallbackBot.replace(/\/+$/, "") : null;

// Subscription URL fallback. The .env entry already ends with `?sub=` so
// the caller just appends the short_uuid (taken from the panel's public
// <panel-host>/<KEY> URL). Empty if the operator hasn't set it — in
// which case we skip the retry path.
const fallbackSubs = (import.meta.env.VITE_FALLBACK_SUBS_DOMAIN ?? "").trim();
export const SUBS_FALLBACK_URL: string | null = fallbackSubs ? fallbackSubs : null;
