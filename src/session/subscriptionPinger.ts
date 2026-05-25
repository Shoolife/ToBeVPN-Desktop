// Direct GET on the panel's public subscription URL with HWID headers.
// This is the only request the subscription panel parses to create/refresh an
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
const BLOCK_HEADER = "is_hack";
const BLOCK_VALUE = "yes";

export interface SubscriptionPingResult {
  intervalMs: number | null;
  isUsageBlocked: boolean;
}

/**
 * Best-effort HWID ping against the subscription URL. Tries the original
 * panel URL first; on network failure / timeout retries the same key
 * against the configured fallback endpoint so the HWID record still
 * lands even when the panel is unreachable (network block, partner outage).
 *
 * Returns the panel-recommended auto-refresh cadence and the access state
 * from the response. Returns `null` when the URL is missing or both legs
 * fail; callers keep any previously recorded access state in that case.
 */
export async function pingSubscriptionUrl(
  subscriptionUrl: string | null | undefined,
): Promise<SubscriptionPingResult | null> {
  if (!subscriptionUrl) return null;
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
      const res = await timedFetch(subscriptionUrl, headers, PRIMARY_TIMEOUT_MS);
      return readResult(res);
    } catch (primaryError) {
      const fallback = buildFallbackUrl(subscriptionUrl);
      if (!fallback) throw primaryError;
      console.warn("[pingSubscriptionUrl] primary failed, retrying via fallback");
      const res = await timedFetch(fallback, headers, FALLBACK_TIMEOUT_MS);
      return readResult(res);
    }
  } catch {
    console.warn("[pingSubscriptionUrl] failed");
    return null;
  }
}

async function timedFetch(url: string, headers: HeadersInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await httpFetch(url, { method: "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Floor at 1h so a misconfigured panel can't cause the client to hammer it;
// ceiling at 7d so a typo'd value doesn't disable refreshes for the
// foreseeable future.
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 7;

function readResult(response: Response): SubscriptionPingResult {
  return {
    intervalMs: readIntervalMs(response.headers.get("profile-update-interval")),
    isUsageBlocked: response.headers.get(BLOCK_HEADER)?.trim() === BLOCK_VALUE,
  };
}

function readIntervalMs(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = parseFloat(raw.trim());
  if (!isFinite(parsed) || parsed <= 0) return null;
  const hours = Math.min(Math.max(parsed, MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS);
  return hours * 60 * 60 * 1000;
}

/**
 * Derives the fallback endpoint URL from the panel URL by extracting
 * the trailing path segment (the subscription key) and appending it
 * to SUBS_FALLBACK_URL, which is configured to already end with
 * `?sub=`. Returns null if the operator hasn't set the fallback or
 * the input URL has no key segment.
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
