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
const FALLBACK_TIMEOUT_MS = 7_000;
const FALLBACK_HEDGE_DELAY_MS = 400;
const PRIMARY_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const FALLBACK_HTTP_STATUS = 403;
const BLOCK_HEADER = "is-hack";
const BLOCK_VALUE = "yes";
const UPDATE_REQUIRED_HEADER = "update-required";

let primaryUnavailableUntil = 0;

export interface SubscriptionPingResult {
  intervalMs: number | null;
  isUsageBlocked: boolean;
  isUpdateRequired: boolean;
}

/**
 * Best-effort device ping against the subscription URL. Tries the original
 * URL first; on network failure, timeout, or a route-rejection response,
 * retries the same key against the configured fallback endpoint.
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

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function firstSuccessful<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    let firstError: unknown = null;
    for (const promise of promises) {
      promise
        .then(resolve)
        .catch((error) => {
          if (firstError === null) firstError = error;
          pending -= 1;
          if (pending === 0) {
            reject(firstError instanceof Error ? firstError : new Error("Network request failed"));
          }
        });
    }
  });
}

/**
 * Start the primary subscription URL first, then hedge through the configured
 * fallback after a short delay. This avoids an 8-second stall on networks
 * where the primary route is blocked while still preferring a fast primary.
 * Both hosts must remain in the Tauri HTTP scope and control-plane bypass.
 */
async function primaryThenFallback(
  primaryUrl: string,
  fallbackUrl: string | null,
  headers: HeadersInit,
): Promise<SubscriptionPingResult> {
  if (!fallbackUrl) {
    return readResult(await timedFetch(primaryUrl, headers, PRIMARY_TIMEOUT_MS));
  }

  if (primaryUnavailableUntil > Date.now()) {
    try {
      const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      return readResult(response);
    } catch {
      const response = await timedFetch(primaryUrl, headers, PRIMARY_TIMEOUT_MS);
      primaryUnavailableUntil = 0;
      return readResult(response);
    }
  }

  type HedgedResponse = {
    source: "primary" | "fallback";
    response: Response;
  };
  let rejectedPrimaryResult: SubscriptionPingResult | null = null;
  const primaryPromise: Promise<HedgedResponse> = timedFetch(
    primaryUrl,
    headers,
    PRIMARY_TIMEOUT_MS,
  ).then((response) => {
    if (response.status === FALLBACK_HTTP_STATUS) {
      rejectedPrimaryResult = readResult(response);
      throw new Error("Primary subscription route rejected request");
    }
    return { source: "primary", response };
  });
  const fallbackPromise: Promise<HedgedResponse> = (async () => {
    await delayMs(FALLBACK_HEDGE_DELAY_MS);
    return timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
  })().then((response) => ({ source: "fallback", response }));

  let winner: HedgedResponse;
  try {
    winner = await firstSuccessful([primaryPromise, fallbackPromise]);
  } catch (error) {
    if (rejectedPrimaryResult) {
      primaryUnavailableUntil = Date.now() + PRIMARY_FAILURE_COOLDOWN_MS;
      return rejectedPrimaryResult;
    }
    throw error;
  }
  if (winner.source === "primary") {
    primaryUnavailableUntil = 0;
  } else {
    primaryUnavailableUntil = Date.now() + PRIMARY_FAILURE_COOLDOWN_MS;
  }
  return readResult(winner.response);
}

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
