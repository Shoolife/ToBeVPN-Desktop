// Direct GET on the panel's public subscription URL with HWID headers.
// This is the only request panel actually parses to create/refresh an
// HWID device record; the bot's /api/* endpoints don't expose it to the panel.
// We hit the URL (a) before each VPN connect, (b) on subscription refresh.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { SUBS_FALLBACK_URL } from "../api/config";
import { getDeviceFingerprint } from "./fingerprint";

// Panel sets `access-control-allow-origin: *`, so window.fetch would also work
// from a webview. We use tauriFetch in production for consistency with the rest
// of the API client (avoids any platform CORS quirks).
const httpFetch: typeof fetch = import.meta.env.DEV ? window.fetch.bind(window) : tauriFetch;

const PRIMARY_TIMEOUT_MS = 8_000;
const FALLBACK_TIMEOUT_MS = 7_000;

/**
 * Best-effort HWID ping against the subscription URL. Tries the original
 * panel URL first; on network failure / timeout retries the same key
 * against the fallback endpoint fallback so the HWID record still
 * lands even when the panel is unreachable (RKN block, partner outage).
 */
export async function pingSubscriptionUrl(
  subscriptionUrl: string | null | undefined,
): Promise<void> {
  if (!subscriptionUrl) return;
  try {
    const fp = await getDeviceFingerprint();
    const headers: HeadersInit = {
      "x-device-os": fp.platform,
      "x-ver-os": fp.osVersion,
      "x-device-model": fp.model,
      "User-Agent": fp.userAgent,
    };
    if (fp.hwid) (headers as Record<string, string>)["x-hwid"] = fp.hwid;

    try {
      await timedFetch(subscriptionUrl, headers, PRIMARY_TIMEOUT_MS);
      return;
    } catch (primaryError) {
      const fallback = buildFallbackUrl(subscriptionUrl);
      if (!fallback) throw primaryError;
      console.warn(
        "[pingSubscriptionUrl] primary failed, falling back to fallback endpoint:",
        primaryError,
      );
      await timedFetch(fallback, headers, FALLBACK_TIMEOUT_MS);
    }
  } catch (e) {
    console.warn("[pingSubscriptionUrl] failed:", e);
  }
}

async function timedFetch(url: string, headers: HeadersInit, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    await httpFetch(url, { method: "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Derives the fallback endpoint fallback URL from the panel URL by
 * extracting the trailing path segment (the subscription key) and
 * appending it to SUBS_FALLBACK_URL, which is configured to already
 * end with `?sub=`. Returns null if the operator hasn't set the
 * fallback or the input URL has no key segment.
 */
function buildFallbackUrl(panelUrl: string): string | null {
  if (!SUBS_FALLBACK_URL) return null;
  let key: string;
  try {
    const u = new URL(panelUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    key = segments[segments.length - 1] ?? "";
  } catch {
    return null;
  }
  if (!key) return null;
  return `${SUBS_FALLBACK_URL}${encodeURIComponent(key)}`;
}
