// Direct GET on the panel's public subscription URL with HWID headers.
// This is the only request the subscription panel parses to create/refresh an
// HWID device record; the bot's /api/* endpoints don't expose it to the panel.
// We hit the URL (a) before each VPN connect, (b) on subscription refresh.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { SUBSCRIPTION_BASE_URL, SUBS_FALLBACK_URL } from "../api/config";
import { getDeviceFingerprint } from "./fingerprint";
import { getSession } from "./store";
import { recordDiagnosticEvent } from "./diagnostics";

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
// Wait this long for the primary before trying the fallback, as on Android.
const FAST_PRIMARY_TIMEOUT_MS = 1_200;
const PRIMARY_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const FALLBACK_HTTP_STATUS = 403;
const BLOCK_HEADER = "is-hack";
const BLOCK_VALUE = "yes";
const SUBSCRIPTION_USERINFO_HEADER = "subscription-userinfo";
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;
const MAX_PROFILE_LINKS = 512;
const MAX_PROFILE_LINK_LENGTH = 16 * 1024;

declare const __APP_VERSION__: string;

let primaryUnavailableUntil = 0;

export interface SubscriptionPingResult {
  intervalMs: number | null;
  isUsageBlocked: boolean;
  isUpdateRequired: boolean;
  /** From the subscription-userinfo header, which every response carries. */
  trafficUsedBytes: number | null;
  trafficLimitBytes: number | null;
}

export interface SubscriptionProfileResult extends SubscriptionPingResult {
  links: string[];
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
  const startedAt = performance.now();
  const finish = (result: SubscriptionPingResult | null): SubscriptionPingResult | null => {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (!result) {
      recordDiagnosticEvent(
        "Subscription-Network",
        `Access request has no configured route; elapsed_ms=${elapsedMs}`,
        "W",
      );
    } else if (result.isUsageBlocked || result.isUpdateRequired || elapsedMs >= 3_000) {
      recordDiagnosticEvent(
        "Subscription-Network",
        `Access request completed; blocked=${result.isUsageBlocked}, update_required=${result.isUpdateRequired}, elapsed_ms=${elapsedMs}`,
        result.isUsageBlocked ? "W" : "D",
      );
    }
    return result;
  };
  try {
    const { headers, minimumVersionHeader } = await buildSubscriptionRequestContext();
    if (!subscriptionUrl) {
      const primaryUrl = buildPrimaryUrlFromKey(subscriptionKey);
      const fallbackUrl = buildFallbackUrlFromKey(subscriptionKey);
      if (primaryUrl) {
        return finish(await primaryThenFallback(
          primaryUrl,
          fallbackUrl,
          headers,
          minimumVersionHeader,
        ));
      }
      if (!fallbackUrl) return finish(null);
      const response = await fallbackFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      if (await isProxyGatewayAuthError(response)) return finish(null);
      return finish(readResult(response, minimumVersionHeader));
    }
    const fallbackUrl = buildFallbackUrl(subscriptionUrl);
    return finish(await primaryThenFallback(
      subscriptionUrl,
      fallbackUrl,
      headers,
      minimumVersionHeader,
    ));
  } catch (error) {
    console.warn("[pingSubscriptionUrl] failed");
    recordDiagnosticEvent(
      "Subscription-Network",
      `Access request failed; reason=${diagnosticNetworkFailure(error)}, elapsed_ms=${Math.max(0, Math.round(performance.now() - startedAt))}`,
      "W",
    );
    return null;
  }
}

export async function fetchSubscriptionProfile(
  subscriptionUrl: string | null | undefined,
  subscriptionKey?: string | null,
): Promise<SubscriptionProfileResult | null> {
  const startedAt = performance.now();
  const finish = (result: SubscriptionProfileResult | null): SubscriptionProfileResult | null => {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    recordDiagnosticEvent(
      "Subscription-Profile",
      result
        ? `Profile request completed; successful=${result.isSuccessful}, links=${result.links.length}, blocked=${result.isUsageBlocked}, update_required=${result.isUpdateRequired}, elapsed_ms=${elapsedMs}`
        : `Profile request has no configured route; elapsed_ms=${elapsedMs}`,
      result?.isSuccessful ? "D" : "W",
    );
    return result;
  };
  try {
    const { headers, minimumVersionHeader } = await buildSubscriptionRequestContext();
    if (!subscriptionUrl) {
      const primaryUrl = buildPrimaryUrlFromKey(subscriptionKey);
      const fallbackUrl = buildFallbackUrlFromKey(subscriptionKey);
      if (primaryUrl) {
        return finish(await primaryThenFallbackProfile(
          primaryUrl,
          fallbackUrl,
          headers,
          minimumVersionHeader,
        ));
      }
      if (!fallbackUrl) return finish(null);
      const response = await fallbackFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
      if (await isProxyGatewayAuthError(response)) return finish(null);
      return finish(await readProfileResult(response, minimumVersionHeader));
    }
    const fallbackUrl = buildFallbackUrl(subscriptionUrl);
    return finish(await primaryThenFallbackProfile(
      subscriptionUrl,
      fallbackUrl,
      headers,
      minimumVersionHeader,
    ));
  } catch (error) {
    console.warn("[fetchSubscriptionProfile] failed");
    recordDiagnosticEvent(
      "Subscription-Profile",
      `Profile request failed; reason=${diagnosticNetworkFailure(error)}, elapsed_ms=${Math.max(0, Math.round(performance.now() - startedAt))}`,
      "W",
    );
    return null;
  }
}

function diagnosticNetworkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("abort") || message.includes("timeout")) return "timeout";
  if (message.includes("reject") || message.includes("forbidden")) return "rejected";
  return "network";
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

const DEVICE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The device id as the fallback proxy expects it: "u1." and the same UUID
 * without dashes, case kept; the proxy restores the dashes. Null when the
 * id is not a UUID (as on Android).
 */
export function encodeFallbackDeviceRef(deviceId: string): string | null {
  return DEVICE_UUID.test(deviceId) ? `u1.${deviceId.replace(/-/g, "")}` : null;
}

/**
 * Headers for a request to the fallback: x-hwid is replaced by x-device-ref
 * (the fallback CDN answers 403 to a UUID in x-hwid; its proxy turns the
 * reference back into x-hwid for Remnawave). Null without a usable id: the
 * fallback is never sent anonymously or with a made-up id.
 */
export function fallbackHeaders(headers: Record<string, string>): Record<string, string> | null {
  const { "x-hwid": hwid, "x-device-ref": _stale, ...rest } = headers;
  const ref = hwid ? encodeFallbackDeviceRef(hwid) : null;
  return ref ? { ...rest, "x-device-ref": ref } : null;
}

/** Every request to the fallback goes through here; primary ones keep x-hwid. */
async function fallbackFetch(url: string, headers: HeadersInit, timeoutMs: number): Promise<Response> {
  const converted = fallbackHeaders(headers as Record<string, string>);
  if (!converted) throw new Error("Fallback device reference cannot be encoded");
  return timedFetch(url, converted, timeoutMs);
}

/**
 * One request at a time, as on Android: the primary gets
 * FAST_PRIMARY_TIMEOUT_MS, and the fallback is sent only after it failed,
 * timed out or answered 403. A rejected primary answer is kept as the result
 * when the fallback cannot do better.
 */
async function primaryOrFallback(
  primaryUrl: string,
  fallbackUrl: string,
  headers: HeadersInit,
): Promise<Response> {
  let rejectedPrimary: Response | null = null;
  try {
    const response = await timedFetch(primaryUrl, headers, FAST_PRIMARY_TIMEOUT_MS);
    if (response.status !== FALLBACK_HTTP_STATUS) {
      primaryUnavailableUntil = 0;
      return response;
    }
    rejectedPrimary = response;
  } catch {
    // Network failure or timeout: try the fallback below.
  }
  primaryUnavailableUntil = performance.now() + PRIMARY_FAILURE_COOLDOWN_MS;
  try {
    const response = await fallbackFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
    if (await isProxyGatewayAuthError(response)) {
      throw new Error("Fallback route rejected request");
    }
    return response;
  } catch (error) {
    if (rejectedPrimary) return rejectedPrimary;
    throw error;
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

/**
 * Try the primary subscription URL first and the configured fallback only
 * after it fails (see primaryOrFallback). The short primary timeout avoids
 * an 8-second stall on networks where the primary route is blocked.
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

  if (primaryUnavailableUntil > performance.now()) {
    try {
      const response = await fallbackFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
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

  return readResult(await primaryOrFallback(primaryUrl, fallbackUrl, headers), minimumVersionHeader);
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

  if (primaryUnavailableUntil > performance.now()) {
    try {
      const response = await fallbackFetch(fallbackUrl, headers, FALLBACK_TIMEOUT_MS);
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

  return readProfileResult(await primaryOrFallback(primaryUrl, fallbackUrl, headers), minimumVersionHeader);
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
  const userInfo = readSubscriptionUserInfo(response.headers.get(SUBSCRIPTION_USERINFO_HEADER));
  return {
    intervalMs: readIntervalMs(response.headers.get("profile-update-interval")),
    isUsageBlocked: readUsageBlocked(response.headers),
    isUpdateRequired: isVersionBelowMinimum(
      minimumVersionHeader ? response.headers.get(minimumVersionHeader) : null,
    ),
    trafficUsedBytes: userInfo.usedBytes,
    trafficLimitBytes: userInfo.totalBytes,
  };
}

async function readProfileResult(
  response: Response,
  minimumVersionHeader: string | null,
): Promise<SubscriptionProfileResult> {
  const body = await response.text().catch(() => "");
  return {
    ...readResult(response, minimumVersionHeader),
    links: parseProfileLinks(body),
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
  if (!raw || raw.length > 64) return null;
  const normalized = raw
    .trim()
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
    .reduce(
      (sum, value) => Math.min(Number.MAX_SAFE_INTEGER, sum + value),
      0,
    );
  return {
    usedBytes: upload === null && download === null ? null : used,
    totalBytes: total,
  };
}

function parseIntegerHeader(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,20}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseProfileLinks(body: string): string[] {
  const direct = extractVlessLinks(body);
  if (direct.length > 0) return direct;
  const decoded = decodeBase64Profile(body);
  return decoded ? extractVlessLinks(decoded) : [];
}

function extractVlessLinks(text: string): string[] {
  // VLESS and Hysteria2 ("hysteria2://" or the short "hy2://") links.
  return Array.from(new Set(text.match(/(?:vless|hysteria2|hy2):\/\/[^\s<>"']+/g) ?? []))
    .filter((link) => link.length <= MAX_PROFILE_LINK_LENGTH)
    .slice(0, MAX_PROFILE_LINKS);
}

function decodeBase64Profile(raw: string): string | null {
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function readIntervalMs(raw: string | null): number | null {
  const normalized = raw?.trim() ?? "";
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
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
  return fallbackSubscriptionUrl(SUBS_FALLBACK_URL, key);
}

/**
 * Extensions the fallback CDN serves the subscription under (each checked
 * against the live service); the proxy strips it to find the key.
 */
export const FALLBACK_SUBS_EXTENSIONS = [
  "txt", "json", "css", "js", "html",
  "xml", "svg", "png", "jpg", "woff2",
] as const;

// "{ext}" as written in the build setting, or percent-encoded by URL parsing.
const FALLBACK_EXT_PLACEHOLDER = /\{ext\}|%7Bext%7D/i;

/**
 * The template with its "{ext}" replaced by a random allowed extension; a
 * template without "{ext}" is returned as is (no extension is added).
 */
export function resolveFallbackExtension(
  base: string,
  pick: () => string = () =>
    FALLBACK_SUBS_EXTENSIONS[Math.floor(Math.random() * FALLBACK_SUBS_EXTENSIONS.length)],
): string {
  return FALLBACK_EXT_PLACEHOLDER.test(base) ? base.replace(FALLBACK_EXT_PLACEHOLDER, pick()) : base;
}

// "{key}" / "{sub}" as written in the build setting, or percent-encoded the
// way URL parsing in config.ts leaves it.
const FALLBACK_KEY_PLACEHOLDER = /\{(?:key|sub)\}|%7B(?:key|sub)%7D/i;

/**
 * The fallback subscription URL for a key, as on Android: a "{key}" (or
 * "{sub}") placeholder anywhere ("https://cdn.example/api/sub/{key}"),
 * otherwise the "sub" query parameter ("https://fn.example/?sub=").
 */
export function fallbackSubscriptionUrl(base: string, key: string): string | null {
  // One extension per built fallback URL; the retries of one subscription
  // request reuse that URL.
  base = resolveFallbackExtension(base);
  try {
    const url = FALLBACK_KEY_PLACEHOLDER.test(base)
      ? new URL(base.replace(FALLBACK_KEY_PLACEHOLDER, encodeURIComponent(key)))
      : new URL(base);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!FALLBACK_KEY_PLACEHOLDER.test(base)) url.searchParams.set("sub", key);
    return url.toString();
  } catch {
    return null;
  }
}
