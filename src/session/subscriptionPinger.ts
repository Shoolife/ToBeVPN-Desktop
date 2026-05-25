// Direct GET on the panel's public subscription URL with HWID headers.
// This is the only request the subscription panel parses to create/refresh an
// HWID device record; the bot's /api/* endpoints don't expose it to the panel.
// We hit the URL (a) before each VPN connect, (b) on subscription refresh.
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

const PRIMARY_TIMEOUT_MS = 8_000;
const PRIMARY_HEDGED_TIMEOUT_MS = 3_000;
const FALLBACK_TIMEOUT_MS = 7_000;
// Start the fallback before the primary leg fully times out. A blackholed
// primary route otherwise adds the whole 8s timeout to every VPN connect.
const FALLBACK_HEDGE_DELAY_MS = 900;
const BLOCK_HEADER = "is-hack";
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

    const fallback = buildFallbackUrl(subscriptionUrl);
    if (fallback) {
      return await hedgedPing(subscriptionUrl, fallback, headers);
    }
    return readResult(await timedFetch(subscriptionUrl, headers, PRIMARY_TIMEOUT_MS));
  } catch {
    console.warn("[pingSubscriptionUrl] failed");
    return null;
  }
}

interface TimedRequest {
  promise: Promise<Response>;
  abort: () => void;
}

function startTimedFetch(url: string, headers: HeadersInit, timeoutMs: number): TimedRequest {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const promise = httpFetch(url, { method: "GET", headers, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
  return {
    promise,
    abort: () => {
      clearTimeout(timeoutId);
      controller.abort();
    },
  };
}

async function timedFetch(url: string, headers: HeadersInit, timeoutMs: number): Promise<Response> {
  const request = startTimedFetch(url, headers, timeoutMs);
  return request.promise;
}

async function hedgedPing(
  primaryUrl: string,
  fallbackUrl: string,
  headers: HeadersInit,
): Promise<SubscriptionPingResult> {
  const primary = startTimedFetch(primaryUrl, headers, PRIMARY_HEDGED_TIMEOUT_MS);
  let fallback: TimedRequest | null = null;
  let fallbackTimer: number | null = null;

  return new Promise<SubscriptionPingResult>((resolve, reject) => {
    let settled = false;
    let primaryFailed = false;
    let fallbackFailed = false;
    let primaryError: unknown = null;
    let fallbackError: unknown = null;
    let fallbackResult: SubscriptionPingResult | null = null;

    const cleanup = () => {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const finish = (result: SubscriptionPingResult, winner: "primary" | "fallback") => {
      if (settled) return;
      settled = true;
      cleanup();
      if (winner === "primary") {
        fallback?.abort();
      } else {
        primary.abort();
      }
      resolve(result);
    };

    const handlePrimaryResponse = (response: Response) => {
      finish(readResult(response), "primary");
    };

    const handleFallbackResponse = (response: Response) => {
      const result = readResult(response);
      if (result.isUsageBlocked || primaryFailed) {
        finish(result, "fallback");
        return;
      }
      fallbackResult = result;
    };

    const failIfBothFailed = () => {
      if (!primaryFailed || !fallbackFailed || settled) return;
      settled = true;
      cleanup();
      primary.abort();
      fallback?.abort();
      reject(fallbackError ?? primaryError);
    };

    const startFallback = () => {
      if (settled || fallback) return;
      console.warn("[pingSubscriptionUrl] using fallback leg");
      fallback = startTimedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      fallback.promise
        .then(handleFallbackResponse)
        .catch((error) => {
          fallbackFailed = true;
          fallbackError = error;
          failIfBothFailed();
        });
    };

    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = null;
      startFallback();
    }, FALLBACK_HEDGE_DELAY_MS);

    primary.promise
      .then(handlePrimaryResponse)
      .catch((error) => {
        primaryFailed = true;
        primaryError = error;
        if (fallbackResult) {
          finish(fallbackResult, "fallback");
          return;
        }
        if (fallbackTimer !== null) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
          startFallback();
        }
        failIfBothFailed();
      });
  });
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
