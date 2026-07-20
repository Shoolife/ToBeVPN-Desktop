// Thin fetch wrapper for the bot backend using per-device sessions.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { BOT_API_BASE_URL, BOT_API_FALLBACK_URL, CONTROL_PLANE_BYPASS_HOSTS } from "./config";
import { getDeviceFingerprint } from "../session/fingerprint";
import {
  clearSessionTokens,
  getSession,
  getSessionGeneration,
  hasValidAccessToken,
  hasValidRefreshToken,
  updateSession,
  updateSessionFromTokens,
} from "../session/store";
import {
  clearSecureSession,
  persistCurrentSessionSecrets,
} from "../session/secureSession";
import type {
  ApiResponse,
  AuthRequestDto,
  AuthRequestResponseDto,
  AuthStatusDto,
  BootstrapRequestDto,
  CurrentPlanDto,
  DeviceRegisterRequestDto,
  DeviceUnlinkRequestDto,
  DeviceUnlinkResponseDto,
  LinkedDevicesDto,
  PanelNodeDto,
  PanelResponse,
  PanelUserDto,
  PurchasePlansDto,
  RefreshRequestDto,
  SaveEmailRequestDto,
  SessionTokensDto,
  TvPairCreateRequestDto,
  TvPairCreateResponseDto,
  TvPairStatusDto,
} from "./types";

// In production the WebKit webview origin (tauri://localhost) is rejected by
// CORS, so route HTTP through the Rust-side plugin which bypasses CORS.
// In dev we keep window.fetch so Vite's /api proxy continues to work.
const httpFetch: typeof fetch = import.meta.env.DEV ? window.fetch.bind(window) : tauriFetch;

type AuthMode = "access" | "none";
const DEVICE_ID_NAMESPACE = "tobevpn:desktop:device-id:v1";
const DIRECT_AUTH_HEADER = "Authorization";
const FALLBACK_AUTH_PREFIX = ["X", "Proxy"].join("-");
const FALLBACK_AUTH_HEADER = `${FALLBACK_AUTH_PREFIX}-${DIRECT_AUTH_HEADER}`;

export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

function resolveBase(base: string = BOT_API_BASE_URL): string {
  if (base === "/" || base === "") return window.location.origin + "/";
  return base;
}

function buildUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
  base?: string,
): string {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(trimmed, resolveBase(base));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Build the fallback URL for the proxy function. The function receives the
 * original API target in `u` as host + path + query, e.g.
 * `<primary-host>/api/config?x=1`. Method/body/headers are preserved by the
 * retry call itself.
 */
function buildFallbackBotUrl(
  path: string,
  query: Record<string, string | number | undefined> | undefined,
  fallbackProxyUrl: string,
): string | null {
  try {
    const primary = new URL(buildUrl(path, query, BOT_API_BASE_URL));
    const target = `${primary.host}${primary.pathname}${primary.search}`;
    const normalizedFallback = fallbackProxyUrl.match(/^https?:\/\//)
      ? fallbackProxyUrl
      : `https://${fallbackProxyUrl}`;
    const url = new URL(normalizedFallback);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("u", target);
    return url.toString();
  } catch {
    return null;
  }
}

// Hard ceiling on every API call. Without this a broken VPN tunnel leaves the
// fetch pending forever — even after the user disconnects — because the
// underlying TCP socket was opened through a route that no longer exists.
// Split between primary and fallback so a single user-visible request never
// exceeds REQUEST_TIMEOUT_MS even when both legs fire.
const PRIMARY_TIMEOUT_MS = 8_000;
const FALLBACK_TIMEOUT_MS = 7_000;
const REQUEST_TIMEOUT_MS = PRIMARY_TIMEOUT_MS + FALLBACK_TIMEOUT_MS;
const FALLBACK_HEDGE_DELAY_MS = 400;
const PRIMARY_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const FALLBACK_HTTP_STATUS = 403;
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 8_000;
const BODY_TOTAL_TIMEOUT_MS = 15_000;

let tokenOperation: { generation: number; promise: Promise<string | null> } | null = null;
let primaryUnavailableUntil = 0;

function publicErrorMessage(raw: string): string {
  let message = raw
    .replace(/https?:\/\/[^\s)]+/gi, "[configured endpoint]")
    .replace(/[\n\r\t]+/g, " ")
    .trim();
  const session = getSession();
  for (const credential of [session.accessToken, session.refreshToken]) {
    if (credential && credential.length >= 8) {
      message = message.split(credential).join("[credential]");
    }
  }
  // A buggy backend may echo a pairing/refresh token that is not yet stored
  // in the session. Redact long token-shaped base64url values before the
  // message reaches either the UI or developer console.
  message = message.replace(
    /\b[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9_-]{8,}){0,2}\b/g,
    "[credential]",
  );
  for (const hostname of CONTROL_PLANE_BYPASS_HOSTS) {
    message = message.split(hostname).join("[configured host]");
  }
  return message.slice(0, 200);
}

function runTokenOperation(
  operation: () => Promise<string | null>,
): Promise<string | null> {
  const generation = getSessionGeneration();
  if (tokenOperation?.generation === generation) return tokenOperation.promise;
  const promise = operation().finally(() => {
    if (tokenOperation?.promise === promise) tokenOperation = null;
  });
  tokenOperation = { generation, promise };
  return promise;
}

function isInvalidSessionTokenError(error: unknown): boolean {
  return error instanceof ApiHttpError && isInvalidSessionStatus(error.status);
}

function isInvalidSessionStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// Single attempt against one base URL with its own abort controller. Lifting
// this out of performFetch lets read requests use a delayed fallback hedge
// while each route keeps its own timeout and honours the caller's abort signal.
async function attemptFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  userSignal: AbortSignal | null | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromUser = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort();
    } else {
      userSignal.addEventListener("abort", abortFromUser, { once: true });
    }
  }
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await httpFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && (!userSignal || !userSignal.aborted)) {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw new Error("Network request failed");
  } finally {
    clearTimeout(timeoutId);
    userSignal?.removeEventListener("abort", abortFromUser);
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

async function fallbackFirstFetch(
  primaryUrl: string,
  fallbackUrl: string,
  primaryInit: RequestInit,
  fallbackInit: RequestInit,
  userSignal: AbortSignal | null | undefined,
): Promise<Response> {
  let rejectedFallbackResponse: Response | null = null;
  try {
    const response = await attemptFetch(fallbackUrl, fallbackInit, FALLBACK_TIMEOUT_MS, userSignal);
    const checked = await rejectProxyGatewayAuthError(response);
    if (checked.status === 429 || checked.status >= 500) {
      rejectedFallbackResponse = checked;
      throw new Error("Fallback route rejected request");
    }
    return checked;
  } catch (fallbackError) {
    if (userSignal?.aborted) throw fallbackError;
    try {
      const response = await attemptFetch(primaryUrl, primaryInit, PRIMARY_TIMEOUT_MS, userSignal);
      primaryUnavailableUntil = 0;
      return response;
    } catch (primaryError) {
      if (rejectedFallbackResponse) return rejectedFallbackResponse;
      throw primaryError;
    }
  }
}

async function hedgedGetFetch(
  primaryUrl: string,
  fallbackUrl: string,
  primaryInit: RequestInit,
  fallbackInit: RequestInit,
  userSignal: AbortSignal | null | undefined,
): Promise<Response> {
  type HedgedResponse = {
    source: "primary" | "fallback";
    response: Response;
  };

  const primaryController = new AbortController();
  const fallbackController = new AbortController();
  let rejectedPrimaryResponse: Response | null = null;
  let rejectedFallbackResponse: Response | null = null;
  let primaryFailed = false;
  const abortBoth = () => {
    primaryController.abort();
    fallbackController.abort();
  };
  if (userSignal) {
    if (userSignal.aborted) abortBoth();
    else userSignal.addEventListener("abort", abortBoth, { once: true });
  }

  const primaryPromise: Promise<HedgedResponse> = attemptFetch(
    primaryUrl,
    primaryInit,
    PRIMARY_TIMEOUT_MS,
    primaryController.signal,
  ).then((response) => {
    if (response.status === FALLBACK_HTTP_STATUS || response.status === 429 || response.status >= 500) {
      rejectedPrimaryResponse = response;
      primaryFailed = true;
      throw new Error("Primary route rejected request");
    }
    return { source: "primary" as const, response };
  }).catch((error) => {
    if (!primaryController.signal.aborted) primaryFailed = true;
    throw error;
  });
  const fallbackPromise: Promise<HedgedResponse> = (async () => {
    await delayMs(FALLBACK_HEDGE_DELAY_MS);
    const response = await attemptFetch(
      fallbackUrl,
      fallbackInit,
      FALLBACK_TIMEOUT_MS,
      fallbackController.signal,
    );
    const checked = await rejectProxyGatewayAuthError(response);
    // A fast 429/5xx from the proxy is not a successful hedge: let a slower
    // healthy primary win. Preserve it only as the last-resort HTTP response
    // if the primary transport also fails.
    if (checked.status === 429 || checked.status >= 500) {
      rejectedFallbackResponse = checked;
      throw new Error("Fallback route rejected request");
    }
    return checked;
  })().then((response) => ({ source: "fallback" as const, response }));

  try {
    const winner = await firstSuccessful([primaryPromise, fallbackPromise]);
    if (winner.source === "primary") {
      fallbackController.abort();
      primaryUnavailableUntil = 0;
    } else {
      primaryController.abort();
      // A faster fallback does not prove the primary is unavailable. Enter
      // cooldown only after an actual primary error/retriable HTTP response.
      if (primaryFailed) {
        primaryUnavailableUntil = performance.now() + PRIMARY_FAILURE_COOLDOWN_MS;
      }
    }
    return winner.response;
  } catch {
    if (!userSignal?.aborted) {
      primaryUnavailableUntil = performance.now() + PRIMARY_FAILURE_COOLDOWN_MS;
    }
    if (rejectedPrimaryResponse) return rejectedPrimaryResponse;
    if (rejectedFallbackResponse) return rejectedFallbackResponse;
    throw new Error("Network request failed");
  } finally {
    userSignal?.removeEventListener("abort", abortBoth);
  }
}

function splitPrimaryFallbackInit(init: RequestInit, headers: Headers): {
  primaryInit: RequestInit;
  fallbackInit: RequestInit;
} {
  const primaryHeaders = new Headers(headers);
  primaryHeaders.delete(FALLBACK_AUTH_HEADER);

  const fallbackHeaders = new Headers(headers);
  const bearer = fallbackHeaders.get(DIRECT_AUTH_HEADER);
  fallbackHeaders.delete(DIRECT_AUTH_HEADER);
  fallbackHeaders.delete(FALLBACK_AUTH_HEADER);
  if (bearer) {
    fallbackHeaders.set(FALLBACK_AUTH_HEADER, bearer);
  }

  return {
    primaryInit: { ...init, headers: primaryHeaders },
    fallbackInit: { ...init, headers: fallbackHeaders },
  };
}

async function rejectProxyGatewayAuthError(response: Response): Promise<Response> {
  if (response.status !== FALLBACK_HTTP_STATUS) return response;
  if (!(await isProxyGatewayAuthError(response))) return response;
  throw new Error("Fallback route rejected request");
}

async function performFetch(
  path: string,
  init: RequestInit = {},
  query?: Record<string, string | number | undefined>,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const fingerprint = await getDeviceFingerprint();
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", fingerprint.userAgent);
  }

  const userSignal = init.signal ?? null;
  const { primaryInit, fallbackInit } = splitPrimaryFallbackInit(init, headers);
  const primaryUrl = buildUrl(path, query, BOT_API_BASE_URL);
  const fallbackUrl = BOT_API_FALLBACK_URL
    ? buildFallbackBotUrl(path, query, BOT_API_FALLBACK_URL)
    : null;
  const method = (init.method ?? "GET").toUpperCase();

  const isSafeMethod = method === "GET" || method === "HEAD";

  if (fallbackUrl && isSafeMethod && primaryUnavailableUntil > performance.now()) {
    return fallbackFirstFetch(primaryUrl, fallbackUrl, primaryInit, fallbackInit, userSignal);
  }

  if (fallbackUrl && isSafeMethod) {
    return hedgedGetFetch(primaryUrl, fallbackUrl, primaryInit, fallbackInit, userSignal);
  }

  try {
    return await attemptFetch(
      primaryUrl,
      primaryInit,
      BOT_API_FALLBACK_URL ? PRIMARY_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      userSignal,
    );
  } catch (primaryError) {
    // Never replay a state-changing request after a network error: the
    // primary may have committed it before its response was lost.
    if (!BOT_API_FALLBACK_URL || !isSafeMethod) throw primaryError;
    if (userSignal?.aborted) throw primaryError;
    console.warn(`[bot-api] primary request to ${path} failed, retrying via fallback`);
    if (!fallbackUrl) throw primaryError;
    primaryUnavailableUntil = performance.now() + PRIMARY_FAILURE_COOLDOWN_MS;
    const response = await attemptFetch(
      fallbackUrl,
      fallbackInit,
      FALLBACK_TIMEOUT_MS,
      userSignal,
    );
    return await rejectProxyGatewayAuthError(response);
  }
}

async function isProxyGatewayAuthError(response: Response): Promise<boolean> {
  if (response.status !== FALLBACK_HTTP_STATUS) return false;
  try {
    const text = await readTextLimited(response.clone(), 16 * 1024);
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

async function parseErrorMessage(response: Response): Promise<string> {
  // Cap the surfaced error message length so a hostile/buggy backend payload
  // can't blow up the UI layout. React already escapes the text — no XSS — but
  // multi-MB error bodies or multi-line markdown break the layout.
  try {
    const text = await readTextLimited(response, 64 * 1024);
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string; detail?: string; errorMessage?: string };
      if (typeof parsed.message === "string" && parsed.message.trim())
        return publicErrorMessage(parsed.message);
      if (typeof parsed.detail === "string" && parsed.detail.trim())
        return publicErrorMessage(parsed.detail);
      if (typeof parsed.errorMessage === "string" && parsed.errorMessage.trim())
        return publicErrorMessage(parsed.errorMessage);
    } catch {
      // Not JSON — fall back to raw text.
    }
    return publicErrorMessage(text);
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = readContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error("Response is too large");
  }
  if (!response.body) {
    if (declaredLength === 0 || response.status === 204 || response.status === 205) return "";
    throw new Error("Response body is not available as a bounded stream");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = performance.now() + BODY_TOTAL_TIMEOUT_MS;
  try {
    while (total <= maxBytes) {
      const remainingTime = deadline - performance.now();
      if (remainingTime <= 0) throw new Error("Response body timed out");
      const { done, value } = await readBodyChunk(
        reader,
        Math.min(BODY_READ_TIMEOUT_MS, remainingTime),
      );
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Response is too large");
      chunks.push(value);
    }
  } finally {
    // cancel() can inherit the same stalled transport as read(); releasing it
    // must not pin an API operation forever.
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = BODY_READ_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: number | null = null;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("Response body timed out")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
}

async function readJsonLimited<T>(response: Response): Promise<T> {
  const declaredLength = readContentLength(response);
  if (declaredLength !== null && declaredLength > MAX_API_RESPONSE_BYTES) {
    throw new Error("API response is too large");
  }
  if (!response.body) {
    throw new Error("API response body is not available as a bounded stream");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = performance.now() + BODY_TOTAL_TIMEOUT_MS;
  try {
    while (total <= MAX_API_RESPONSE_BYTES) {
      const remainingTime = deadline - performance.now();
      if (remainingTime <= 0) throw new Error("API response body timed out");
      const { done, value } = await readBodyChunk(
        reader,
        Math.min(BODY_READ_TIMEOUT_MS, remainingTime),
      );
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_API_RESPONSE_BYTES) {
        throw new Error("API response is too large");
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function readBytesLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = readContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error("Response is too large");
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = performance.now() + BODY_TOTAL_TIMEOUT_MS;
  try {
    while (total <= maxBytes) {
      const remainingTime = deadline - performance.now();
      if (remainingTime <= 0) throw new Error("Response body timed out");
      const { done, value } = await readBodyChunk(
        reader,
        Math.min(BODY_READ_TIMEOUT_MS, remainingTime),
      );
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Response is too large");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiHttpError(response.status, await parseErrorMessage(response));
  }
  return await readJsonLimited<T>(response);
}

async function stableDeviceIdFromHwid(hwid: string): Promise<string | null> {
  const normalized = hwid.trim().toLocaleLowerCase("en-US");
  if (!normalized) return null;

  const input = new TextEncoder().encode(`${DEVICE_ID_NAMESPACE}:${normalized}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;

  const hex = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function resolveBootstrapDeviceId(): Promise<string> {
  const session = getSession();

  if (session.isLinked) {
    return session.deviceId;
  }
  try {
    const fingerprint = await getDeviceFingerprint();
    const stableDeviceId = await stableDeviceIdFromHwid(fingerprint.hwid);
    if (stableDeviceId && stableDeviceId !== session.deviceId) {
      return updateSession({ deviceId: stableDeviceId }).deviceId;
    }
  } catch {
    // Fall back to the current install-scoped id if the platform HWID is
    // temporarily unavailable. Existing sessions are still preserved above.
  }

  return getSession().deviceId;
}

async function bootstrapDeviceSessionInternal(): Promise<SessionTokensDto> {
  const generation = getSessionGeneration();
  const deviceId = await resolveBootstrapDeviceId();
  const requestBody: BootstrapRequestDto = {
    device_id: deviceId,
    platform: "desktop",
  };
  const response = await performFetch("api/device/bootstrap", {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  const payload = await expectJson<ApiResponse<SessionTokensDto>>(response);
  if (!payload.success || !payload.data) {
    throw new Error(payload.message ?? "Bootstrap failed");
  }
  if (getSessionGeneration() !== generation) {
    throw new Error("Device session changed while bootstrap was in flight");
  }
  updateSessionFromTokens(payload.data);
  await persistCurrentSessionSecrets();
  return payload.data;
}

export async function bootstrapDeviceSession(): Promise<void> {
  await bootstrapDeviceSessionInternal();
}

async function refreshDeviceSessionInternal(refreshToken: string): Promise<SessionTokensDto> {
  const generation = getSessionGeneration();
  const requestBody: RefreshRequestDto = {
    refresh_token: refreshToken,
  };
  const response = await performFetch("api/device/refresh", {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  const payload = await expectJson<ApiResponse<SessionTokensDto>>(response);
  if (!payload.success || !payload.data) {
    throw new Error(payload.message ?? "Refresh failed");
  }
  if (getSessionGeneration() !== generation) {
    throw new Error("Device session changed while refresh was in flight");
  }
  updateSessionFromTokens(payload.data);
  await persistCurrentSessionSecrets();
  return payload.data;
}

export async function ensureDeviceSession(): Promise<void> {
  const session = getSession();
  if (hasValidAccessToken(session)) return;

  await runTokenOperation(async () => {
    const current = getSession();
    if (hasValidAccessToken(current)) return current.accessToken;

    if (hasValidRefreshToken(current) && current.refreshToken) {
      try {
        const refreshed = await refreshDeviceSessionInternal(current.refreshToken);
        return refreshed.access_token;
      } catch (error) {
        console.warn("[device-session] refresh failed during startup:", error);
        if (isInvalidSessionTokenError(error)) {
          await clearSecureSession();
          clearSessionTokens();
        } else {
          throw error;
        }
      }
    }

    const bootstrapped = await bootstrapDeviceSessionInternal();
    return bootstrapped.access_token;
  });
}

async function getAccessTokenForRequest(): Promise<string | null> {
  const current = getSession();
  if (hasValidAccessToken(current)) return current.accessToken;

  try {
    await ensureDeviceSession();
  } catch (error) {
    console.warn("[device-session] ensureDeviceSession failed:", error);
  }

  const updated = getSession();
  return hasValidAccessToken(updated) ? updated.accessToken : null;
}

async function recoverAccessTokenAfter401(previousToken: string | null): Promise<string | null> {
  const current = getSession();
  if (hasValidAccessToken(current) && current.accessToken !== previousToken) {
    return current.accessToken;
  }

  return runTokenOperation(async () => {
    const latest = getSession();
    if (hasValidAccessToken(latest) && latest.accessToken !== previousToken) {
      return latest.accessToken;
    }

    if (hasValidRefreshToken(latest) && latest.refreshToken) {
      try {
        const refreshed = await refreshDeviceSessionInternal(latest.refreshToken);
        return refreshed.access_token;
      } catch (error) {
        console.warn("[device-session] refresh after 401 failed:", error);
        if (isInvalidSessionTokenError(error)) {
          await clearSecureSession();
          clearSessionTokens();
        } else {
          return null;
        }
      }
    }

    try {
      const bootstrapped = await bootstrapDeviceSessionInternal();
      return bootstrapped.access_token;
    } catch (error) {
      console.warn("[device-session] bootstrap after 401 failed:", error);
      await clearSecureSession();
      clearSessionTokens();
      return null;
    }
  });
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  query?: Record<string, string | number | undefined>,
  authMode: AuthMode = "access",
  retryOnAuthFailure = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  let accessToken: string | null = null;
  const requestGeneration = authMode === "access" ? getSessionGeneration() : null;
  const assertSessionIsCurrent = () => {
    if (
      requestGeneration !== null &&
      getSessionGeneration() !== requestGeneration
    ) {
      throw new Error("Device session changed while request was in flight");
    }
  };

  if (authMode === "access") {
    accessToken = await getAccessTokenForRequest();
    // Never turn an action queued by the old account into an action performed
    // with credentials restored or linked for a newer account.
    assertSessionIsCurrent();
    if (accessToken) {
      headers.set(DIRECT_AUTH_HEADER, `Bearer ${accessToken}`);
    }
  }

  const response = await performFetch(path, { ...init, headers }, query);
  assertSessionIsCurrent();
  const method = (init.method ?? "GET").toUpperCase();
  if (
    isInvalidSessionStatus(response.status) &&
    authMode === "access" &&
    retryOnAuthFailure &&
    (method === "GET" || method === "HEAD")
  ) {
    const recoveredToken = await recoverAccessTokenAfter401(accessToken);
    assertSessionIsCurrent();
    if (recoveredToken) {
      return request(path, init, query, authMode, false);
    }
  }

  const payload = await expectJson<T>(response);
  assertSessionIsCurrent();
  return payload;
}

// --- User avatar ---

// Fetches the current user's Telegram avatar (binary JPEG from
// GET /api/user/avatar, same endpoint the Android client uses). Returns the
// image bytes as a Blob, or null when the user has no photo / the request
// fails. The endpoint is rate-limited, so callers should cache the result
// for the app session instead of re-fetching on every screen open.
export async function fetchUserAvatar(): Promise<Blob | null> {
  const requestGeneration = getSessionGeneration();
  const assertSessionIsCurrent = () => {
    if (getSessionGeneration() !== requestGeneration) {
      throw new Error("Device session changed while avatar was in flight");
    }
  };
  const headers = new Headers();
  const accessToken = await getAccessTokenForRequest();
  assertSessionIsCurrent();
  if (accessToken) headers.set(DIRECT_AUTH_HEADER, `Bearer ${accessToken}`);

  let response = await performFetch("api/user/avatar", { method: "GET", headers });
  assertSessionIsCurrent();
  if (isInvalidSessionStatus(response.status)) {
    const recovered = await recoverAccessTokenAfter401(accessToken);
    assertSessionIsCurrent();
    if (recovered) {
      const retryHeaders = new Headers();
      retryHeaders.set(DIRECT_AUTH_HEADER, `Bearer ${recovered}`);
      response = await performFetch("api/user/avatar", { method: "GET", headers: retryHeaders });
      assertSessionIsCurrent();
    }
  }

  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    // Preserve the distinction between a confirmed missing avatar and a
    // transient/auth/server error so callers do not negative-cache failures.
    throw new ApiHttpError(response.status, "Avatar request failed");
  }
  // The endpoint returns raw JPEG bytes, sometimes with a generic MIME type.
  // Bound both size and read time, then reject HTML/error payloads before an
  // object URL reaches the image decoder.
  const bytes = await readBytesLimited(response, MAX_AVATAR_BYTES);
  assertSessionIsCurrent();
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) return null;
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return new Blob([ownedBytes.buffer], { type: "image/jpeg" });
}

// --- Deep-link authentication ---

export function requestAuth(
  req: AuthRequestDto,
): Promise<ApiResponse<AuthRequestResponseDto>> {
  return request("api/auth/request", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function checkAuthStatus(token: string): Promise<ApiResponse<AuthStatusDto>> {
  return request(
    "api/auth/status",
    { method: "GET" },
    { token: requireBoundedQueryValue(token, "authentication token", 2_048) },
    "none",
  );
}

// --- Devices ---

export function registerDevice(req: DeviceRegisterRequestDto): Promise<ApiResponse<unknown>> {
  return request("api/device/register", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function unlinkDevice(
  req: DeviceUnlinkRequestDto,
): Promise<ApiResponse<DeviceUnlinkResponseDto>> {
  return request("api/device/unlink", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function logoutDevice(): Promise<ApiResponse<unknown>> {
  return request("api/device/logout", { method: "POST" });
}

export function getDevices(): Promise<ApiResponse<LinkedDevicesDto>> {
  return request("api/devices", { method: "GET" });
}

// --- TV pairing ---

export function createTvPairing(
  req: TvPairCreateRequestDto,
): Promise<ApiResponse<TvPairCreateResponseDto>> {
  return request("api/tv/pair/create", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function checkTvPairingStatus(code: string): Promise<ApiResponse<TvPairStatusDto>> {
  return request(
    "api/tv/pair/status",
    { method: "GET" },
    { code: requireBoundedQueryValue(code, "pairing code", 128) },
    "none",
  );
}

function requireBoundedQueryValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

// --- Panel proxy ---

export async function getUserByTelegramId(
  telegramId: number,
): Promise<PanelResponse<PanelUserDto[]>> {
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    throw new Error("Invalid Telegram identity");
  }
  const result = await request<PanelResponse<unknown>>(
    `api/panel/user-by-telegram/${telegramId}`,
    { method: "GET" },
  );
  const source = Array.isArray(result?.response) ? result.response : [];
  const text = (value: unknown, max: number, required = false): string | null => {
    if (typeof value !== "string") return required ? null : "";
    const trimmed = value.trim();
    if ((required && !trimmed) || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return null;
    }
    return trimmed;
  };
  const nonnegative = (value: unknown): number =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  const users: PanelUserDto[] = [];
  for (const raw of source.slice(0, 128)) {
    if (raw === null || typeof raw !== "object") continue;
    const user = raw as Record<string, unknown>;
    const uuid = text(user.uuid, 128, true);
    const shortUuid = text(user.short_uuid, 128, true);
    if (!uuid || !shortUuid) continue;
    const squads = Array.isArray(user.active_internal_squads)
      ? user.active_internal_squads.slice(0, 128).flatMap((rawSquad) => {
          if (rawSquad === null || typeof rawSquad !== "object") return [];
          const squad = rawSquad as Record<string, unknown>;
          const squadUuid = text(squad.uuid, 128, true);
          const name = text(squad.name, 128, true);
          return squadUuid && name ? [{ uuid: squadUuid, name }] : [];
        })
      : [];
    const rawTraffic = user.user_traffic;
    const traffic = rawTraffic !== null && typeof rawTraffic === "object"
      ? rawTraffic as Record<string, unknown>
      : null;
    users.push({
      uuid,
      short_uuid: shortUuid,
      username: text(user.username, 256) ?? "",
      status: text(user.status, 64) ?? "",
      traffic_limit_bytes: nonnegative(user.traffic_limit_bytes),
      traffic_limit_strategy: text(user.traffic_limit_strategy, 64) ?? "",
      expire_at: text(user.expire_at, 128) || null,
      telegram_id:
        Number.isSafeInteger(user.telegram_id) && Number(user.telegram_id) > 0
          ? Number(user.telegram_id)
          : null,
      vless_uuid: text(user.vless_uuid, 128) ?? "",
      subscription_url: text(user.subscription_url, 2_048) ?? "",
      active_internal_squads: squads,
      user_traffic: traffic ? {
        used_traffic_bytes: nonnegative(traffic.used_traffic_bytes),
        lifetime_used_traffic_bytes: nonnegative(traffic.lifetime_used_traffic_bytes),
        online_at: text(traffic.online_at, 128) || null,
        last_connected_node_uuid: text(traffic.last_connected_node_uuid, 128) || null,
      } : null,
      hwid_device_limit:
        Number.isSafeInteger(user.hwid_device_limit) && Number(user.hwid_device_limit) >= 0
          ? Number(user.hwid_device_limit)
          : null,
      email: text(user.email, 320) || null,
      description: text(user.description, 4_096) || null,
    });
  }
  return { response: users };
}

export function getNodes(): Promise<PanelResponse<PanelNodeDto[]>> {
  return request("api/panel/nodes", { method: "GET" });
}

export function getCurrentPlan(): Promise<ApiResponse<CurrentPlanDto>> {
  return request("api/subscription/current-plan", { method: "GET" });
}

// --- Email ---

export function saveEmail(req: SaveEmailRequestDto): Promise<ApiResponse<unknown>> {
  return request("api/device/save-email", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// --- Purchase plans ---

export function getPurchasePlans(): Promise<ApiResponse<PurchasePlansDto>> {
  return request("api/purchase/plans", { method: "GET" });
}
