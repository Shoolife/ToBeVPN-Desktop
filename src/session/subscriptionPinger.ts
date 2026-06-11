// Direct GET on the panel's public subscription URL with HWID headers.
// This is the only request the subscription panel parses to create/refresh an
// HWID device record; the bot's /api/* endpoints don't expose it to the panel.
// We hit the URL (a) before each VPN connect, (b) on subscription refresh.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { SUBSCRIPTION_BASE_URL, SUBS_FALLBACK_URL } from "../api/config";
import { getDeviceFingerprint } from "./fingerprint";
import { getSession } from "./store";

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
const SUBSCRIPTION_USERINFO_HEADER = "subscription-userinfo";
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

declare const __APP_VERSION__: string;

let primaryUnavailableUntil = 0;

export interface SubscriptionPingResult {
  intervalMs: number | null;
  isUsageBlocked: boolean;
  isUpdateRequired: boolean;
}

export interface SubscriptionProfileResult extends SubscriptionPingResult {
  links: string[];
  trafficUsedBytes: number | null;
  trafficLimitBytes: number | null;
  isSuccessful: boolean;
}

/**
 * Device ping against the subscription URL. If only a key is available, the
 * configured primary base restores the direct HWID-tagged request. Network
 * failures and route rejections then use the configured fallback.
 *
 * Returns the panel-recommended auto-refresh cadence and the access state
 * from the response. Returns `null` when the URL is missing or both legs
 * fail; callers keep any previously recorded access state in that case.
 */
export async function pingSubscriptionUrl(
  subscriptionUrl: string | null | undefined,
  subscriptionKey?: string | null,
): Promise<SubscriptionPingResult | null> {
  try {
    const { headers, minimumVersionHeader } = await buildSubscriptionRequestContext();
    if (!subscriptionUrl) {
      const primaryUrl = buildPrimaryUrlFromKey(subscriptionKey);
      const fallbackUrl = buildFallbackUrlFromKey(subscriptionKey);
      if (primaryUrl) {
        return await primaryThenFallback(
          primaryUrl,
          fallbackUrl,
          headers,
          minimumVersionHeader,
        );
      }
      if (!fallbackUrl) return null;
      const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      if (await isProxyGatewayAuthError(response)) return null;
      return readResult(response, minimumVersionHeader);
    }
    const fallbackUrl = buildFallbackUrl(subscriptionUrl);
    return await primaryThenFallback(
      subscriptionUrl,
      fallbackUrl,
      headers,
      minimumVersionHeader,
    );
  } catch {
    console.warn("[pingSubscriptionUrl] failed");
    return null;
  }
}

export async function fetchSubscriptionProfile(
  subscriptionUrl: string | null | undefined,
  subscriptionKey?: string | null,
): Promise<SubscriptionProfileResult | null> {
  try {
    const { headers, minimumVersionHeader } = await buildSubscriptionRequestContext();
    if (!subscriptionUrl) {
      const primaryUrl = buildPrimaryUrlFromKey(subscriptionKey);
      const fallbackUrl = buildFallbackUrlFromKey(subscriptionKey);
      if (primaryUrl) {
        return await primaryThenFallbackProfile(
          primaryUrl,
          fallbackUrl,
          headers,
          minimumVersionHeader,
        );
      }
      if (!fallbackUrl) return null;
      const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      if (await isProxyGatewayAuthError(response)) return null;
      return await readProfileResult(response, minimumVersionHeader);
    }
    const fallbackUrl = buildFallbackUrl(subscriptionUrl);
    return await primaryThenFallbackProfile(
      subscriptionUrl,
      fallbackUrl,
      headers,
      minimumVersionHeader,
    );
  } catch {
    console.warn("[fetchSubscriptionProfile] failed");
    return null;
  }
}

interface SubscriptionRequestContext {
  headers: HeadersInit;
  minimumVersionHeader: string | null;
}

async function buildSubscriptionRequestContext(): Promise<SubscriptionRequestContext> {
  const fp = await getDeviceFingerprint();
  const deviceId = getSession().deviceId.trim();
  const headers: HeadersInit = {
    "x-device-os": fp.platform,
    "x-ver-os": fp.osVersion,
    "x-device-model": fp.model,
    "User-Agent": fp.userAgent,
  };
  if (deviceId) (headers as Record<string, string>)["x-hwid"] = deviceId;
  return {
    headers,
    minimumVersionHeader: minimumVersionHeaderForPlatform(fp.platform),
  };
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

function buildPrimaryUrlFromKey(rawKey: string | null | undefined): string | null {
  const key = rawKey?.trim();
  if (!SUBSCRIPTION_BASE_URL || !key) return null;
  try {
    const base = SUBSCRIPTION_BASE_URL.endsWith("/")
      ? SUBSCRIPTION_BASE_URL
      : `${SUBSCRIPTION_BASE_URL}/`;
    return new URL(encodeURIComponent(key), base).toString();
  } catch {
    return null;
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
  minimumVersionHeader: string | null,
): Promise<SubscriptionPingResult> {
  if (!fallbackUrl) {
    return readResult(
      await timedFetch(primaryUrl, headers, PRIMARY_TIMEOUT_MS),
      minimumVersionHeader,
    );
  }

  if (primaryUnavailableUntil > Date.now()) {
    try {
      const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      if (await isProxyGatewayAuthError(response)) {
        throw new Error("Fallback route rejected request");
      }
      return readResult(response, minimumVersionHeader);
    } catch {
      const response = await timedFetch(primaryUrl, headers, PRIMARY_TIMEOUT_MS);
      primaryUnavailableUntil = 0;
      return readResult(response, minimumVersionHeader);
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
      rejectedPrimaryResult = readResult(response, minimumVersionHeader);
      throw new Error("Primary subscription route rejected request");
    }
    return { source: "primary", response };
  });
  const fallbackPromise: Promise<HedgedResponse> = (async () => {
    await delayMs(FALLBACK_HEDGE_DELAY_MS);
    const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
    if (await isProxyGatewayAuthError(response)) {
      throw new Error("Fallback route rejected request");
    }
    return response;
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
  return readResult(winner.response, minimumVersionHeader);
}

async function primaryThenFallbackProfile(
  primaryUrl: string,
  fallbackUrl: string | null,
  headers: HeadersInit,
  minimumVersionHeader: string | null,
): Promise<SubscriptionProfileResult> {
  if (!fallbackUrl) {
    return readProfileResult(
      await timedFetch(primaryUrl, headers, PRIMARY_TIMEOUT_MS),
      minimumVersionHeader,
    );
  }

  if (primaryUnavailableUntil > Date.now()) {
    try {
      const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      if (await isProxyGatewayAuthError(response)) {
        throw new Error("Fallback route rejected request");
      }
      return readProfileResult(response, minimumVersionHeader);
    } catch {
      const response = await timedFetch(primaryUrl, headers, PRIMARY_TIMEOUT_MS);
      primaryUnavailableUntil = 0;
      return readProfileResult(response, minimumVersionHeader);
    }
  }

  type HedgedResponse = {
    source: "primary" | "fallback";
    response: Response;
  };
  let rejectedPrimaryResult: SubscriptionProfileResult | null = null;
  const primaryPromise: Promise<HedgedResponse> = timedFetch(
    primaryUrl,
    headers,
    PRIMARY_TIMEOUT_MS,
  ).then(async (response) => {
    if (response.status === FALLBACK_HTTP_STATUS) {
      rejectedPrimaryResult = await readProfileResult(response, minimumVersionHeader);
      throw new Error("Primary subscription route rejected request");
    }
    return { source: "primary", response };
  });
  const fallbackPromise: Promise<HedgedResponse> = (async () => {
    await delayMs(FALLBACK_HEDGE_DELAY_MS);
    const response = await timedFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
    if (await isProxyGatewayAuthError(response)) {
      throw new Error("Fallback route rejected request");
    }
    return response;
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
  return readProfileResult(winner.response, minimumVersionHeader);
}

async function isProxyGatewayAuthError(response: Response): Promise<boolean> {
  if (response.status !== FALLBACK_HTTP_STATUS) return false;
  try {
    const text = await response.clone().text();
    if (!text) return false;
    const parsed = JSON.parse(text) as {
      errorCode?: unknown;
      errorMessage?: unknown;
      errorType?: unknown;
    };
    const message = typeof parsed.errorMessage === "string" ? parsed.errorMessage : "";
    const type = typeof parsed.errorType === "string" ? parsed.errorType : "";
    return (
      parsed.errorCode === FALLBACK_HTTP_STATUS &&
      /forbidden:\s*not authorized/i.test(message) &&
      /clienterror/i.test(type)
    );
  } catch {
    return false;
  }
}

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 7;

function readResult(
  response: Response,
  minimumVersionHeader: string | null,
): SubscriptionPingResult {
  return {
    intervalMs: readIntervalMs(response.headers.get("profile-update-interval")),
    isUsageBlocked: readUsageBlocked(response.headers),
    isUpdateRequired: isVersionBelowMinimum(
      minimumVersionHeader ? response.headers.get(minimumVersionHeader) : null,
    ),
  };
}

async function readProfileResult(
  response: Response,
  minimumVersionHeader: string | null,
): Promise<SubscriptionProfileResult> {
  const body = await response.text().catch(() => "");
  const userInfo = readSubscriptionUserInfo(response.headers.get(SUBSCRIPTION_USERINFO_HEADER));
  return {
    ...readResult(response, minimumVersionHeader),
    links: parseProfileLinks(body),
    trafficUsedBytes: userInfo.usedBytes,
    trafficLimitBytes: userInfo.totalBytes,
    isSuccessful: response.ok,
  };
}

function minimumVersionHeaderForPlatform(platform: string): string | null {
  switch (platform.trim().toLowerCase()) {
    case "windows":
      return "min-windows";
    case "linux":
      return "min-linux";
    default:
      return null;
  }
}

function isVersionBelowMinimum(rawMinimum: string | null): boolean {
  const minimum = parseVersion(rawMinimum);
  const current = parseVersion(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null,
  );
  if (!minimum || !current) return false;

  const size = Math.max(minimum.length, current.length);
  for (let index = 0; index < size; index += 1) {
    const currentPart = current[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (currentPart !== minimumPart) return currentPart < minimumPart;
  }
  return false;
}

function parseVersion(raw: string | null): number[] | null {
  const normalized = raw
    ?.trim()
    .replace(/^[vV]/, "")
    .split(/[-+]/, 1)[0];
  if (!normalized || !VERSION_PATTERN.test(normalized)) return null;

  const parts = normalized.split(".").map((part) => Number(part));
  return parts.every((part) => Number.isSafeInteger(part)) ? parts : null;
}

function readUsageBlocked(headers: Headers): boolean {
  const raw = headers.get(BLOCK_HEADER) ?? headers.get("is_hack");
  return raw?.trim().toLowerCase() === BLOCK_VALUE;
}

function readSubscriptionUserInfo(raw: string | null): {
  usedBytes: number | null;
  totalBytes: number | null;
} {
  if (!raw) return { usedBytes: null, totalBytes: null };
  const parts = new Map(
    raw
      .split(";")
      .map((part) => part.trim().split("=", 2))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key.trim().toLowerCase(), value.trim()]),
  );
  const upload = parseIntegerHeader(parts.get("upload"));
  const download = parseIntegerHeader(parts.get("download"));
  const total = parseIntegerHeader(parts.get("total"));
  const used = [upload, download]
    .filter((value): value is number => value !== null)
    .reduce((sum, value) => sum + value, 0);
  return {
    usedBytes: upload === null && download === null ? null : used,
    totalBytes: total,
  };
}

function parseIntegerHeader(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function parseProfileLinks(body: string): string[] {
  const direct = extractVlessLinks(body);
  if (direct.length > 0) return direct;
  const decoded = decodeBase64Profile(body);
  return decoded ? extractVlessLinks(decoded) : [];
}

function extractVlessLinks(text: string): string[] {
  return Array.from(new Set(text.match(/vless:\/\/[^\s<>"']+/g) ?? []));
}

function decodeBase64Profile(raw: string): string | null {
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

function readIntervalMs(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = parseFloat(raw.trim());
  if (!isFinite(parsed) || parsed <= 0) return null;
  const hours = Math.min(Math.max(parsed, MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS);
  return hours * 60 * 60 * 1000;
}

function buildFallbackUrl(panelUrl: string): string | null {
  let key: string;
  try {
    const u = new URL(panelUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    key = segments[segments.length - 1] ?? "";
  } catch {
    return null;
  }
  return buildFallbackUrlFromKey(key);
}

function buildFallbackUrlFromKey(subscriptionKey: string | null | undefined): string | null {
  if (!SUBS_FALLBACK_URL) return null;
  const key = subscriptionKey?.trim();
  if (!key) return null;
  return `${SUBS_FALLBACK_URL}${encodeURIComponent(key)}`;
}
