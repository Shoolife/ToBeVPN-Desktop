// Direct GET on the panel's public subscription URL with HWID headers.
// This is the only request the subscription panel parses to create/refresh an
// HWID device record; the bot's /api/* endpoints don't expose it to the panel.
// We hit the URL (a) before each VPN connect, (b) on subscription refresh.
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { SUBS_FALLBACK_URL } from "../api/config";
import { getDeviceFingerprint } from "./fingerprint";

// Response access headers are not browser-safelisted. Use the Rust-side HTTP
// plugin whenever the app runs inside Tauri, including development builds, so
// block detection does not depend on browser CORS exposure policy.
const httpFetch: typeof fetch =
  typeof window !== "undefined" &&
  import.meta.env.DEV &&
  !("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
    ? window.fetch.bind(window)
    : tauriFetch;

const FALLBACK_TIMEOUT_MS = 7_000;
const BLOCK_HEADER = "is-hack";
const BLOCK_VALUE = "yes";
const UPDATE_REQUIRED_HEADER = "update-required";

export interface SubscriptionPingResult {
  intervalMs: number | null;
  isUsageBlocked: boolean;
  isUpdateRequired: boolean;
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

    const fallbackUrl = buildFallbackUrl(subscriptionUrl);
    return await primaryThenFallback(subscriptionUrl, fallbackUrl, headers);
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

/**
 * Primary ping goes through a Rust command (`fetch_subscription_ping`)
 * that is NOT subject to the Tauri HTTP plugin's build-time scope.
 * The subscription URL host (`__SUBSCRIPTION_HOST__`) is determined at runtime
 * by the panel and will never match the static allowlist.
 *
 * Fallback (Yandex CF) still uses `tauriFetch` because it IS in the
 * allowlist and we only need it when the primary is unreachable.
 */
async function primaryThenFallback(
  primaryUrl: string,
  fallbackUrl: string | null,
  headers: HeadersInit,
): Promise<SubscriptionPingResult> {
  try {
    const fp = await getDeviceFingerprint();
    const raw = await invoke<{
      status: number;
      is_hack: string;
      update_required: string;
      profile_update_interval: string;
    }>("fetch_subscription_ping", {
      url: primaryUrl,
      hwid: fp.hwid ?? "",
      deviceOs: fp.platform,
      osVersion: fp.osVersion,
      deviceModel: fp.model,
      userAgent: fp.userAgent,
    });
    return {
      intervalMs: readIntervalMs(raw.profile_update_interval || null),
      isUsageBlocked: raw.is_hack.trim().toLowerCase() === BLOCK_VALUE,
      isUpdateRequired: raw.update_required.trim().toLowerCase() === BLOCK_VALUE,
    };
  } catch (primaryError) {
    if (!fallbackUrl) throw primaryError;
    try {
      const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      return readResult(response);
    } catch {
      throw primaryError;
    }
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
    isUsageBlocked: readUsageBlocked(response.headers),
    isUpdateRequired:
      (response.headers.get(UPDATE_REQUIRED_HEADER) ?? "").trim().toLowerCase() === BLOCK_VALUE,
  };
}

function readUsageBlocked(headers: Headers): boolean {
  const raw = headers.get(BLOCK_HEADER) ?? headers.get("is_hack");
  return raw?.trim().toLowerCase() === BLOCK_VALUE;
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
