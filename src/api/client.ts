// Thin fetch wrapper for the bot backend using per-device sessions.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { BOT_API_BASE_URL, BOT_API_FALLBACK_URL, CONTROL_PLANE_BYPASS_HOSTS } from "./config";
import { getDeviceFingerprint } from "../session/fingerprint";
import { recordDiagnosticEvent } from "../session/diagnostics";
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
  PromocodeActivateRequestDto,
  PromocodeActivationResultDto,
  PromocodeHistoryDto,
  PurchasePlansDto,
  ReferralsDto,
  RefreshRequestDto,
  SaveEmailRequestDto,
  SetReferrerRequestDto,
  SetReferrerResponseDto,
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

let tokenOperation: { generation: number; promise: Promise<string | null> } | null = null;
let primaryUnavailableUntil = 0;

// Diagnostic names are deliberately fixed and never derived from path/query
// values. Some API routes contain a Telegram id, pairing code or auth token;
// those values must not enter an exportable journal even temporarily.
function diagnosticApiRoute(path: string): string {
  const normalized = path.replace(/^\/+/, "").toLowerCase();
  const routes: Array<[prefix: string, label: string]> = [
    ["api/device/bootstrap", "device-bootstrap"],
    ["api/device/refresh", "device-refresh"],
    ["api/device/register", "device-heartbeat"],
    ["api/device/unlink", "device-unlink"],
    ["api/device/logout", "device-logout"],
    ["api/device/referrer", "referrer"],
    ["api/device/save-email", "save-email"],
    ["api/devices", "devices"],
    ["api/auth/request", "auth-request"],
    ["api/auth/status", "auth-status"],
    ["api/referrals", "referrals"],
    ["api/user/promocodes/activate", "promocode-activate"],
    ["api/user/promocodes", "promocodes"],
    ["api/user/avatar", "avatar"],
    ["api/tv/pair/create", "tv-pair-create"],
    ["api/tv/pair/status", "tv-pair-status"],
    ["api/panel/user-by-telegram", "panel-user"],
    ["api/panel/nodes", "server-metadata"],
    ["api/subscription/current-plan", "current-plan"],
    ["api/purchase/plans", "purchase-plans"],
  ];
  return routes.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? "other";
}

function diagnosticRequestFailure(error: unknown, signal: AbortSignal | null | undefined): string {
  if (signal?.aborted) return "cancelled";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("session changed")) return "session-changed";
  return "network";
}

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
  diagnosticRoute: string,
): Promise<Response> {
  recordDiagnosticEvent(
    "API-Route",
    `Fallback-first request started; route=${diagnosticRoute}`,
    "D",
  );
  let rejectedFallbackResponse: Response | null = null;
  try {
    const response = await attemptFetch(fallbackUrl, fallbackInit, FALLBACK_TIMEOUT_MS, userSignal);
    const validated = await rejectProxyGatewayAuthError(response);
    if (validated.ok) return validated;
    // A fallback HTTP error is not authoritative: the proxy can lag behind
    // the primary API and legitimately have no newer route yet. Keep the
    // response only as a last resort and give the primary a chance to answer.
    rejectedFallbackResponse = validated;
    recordDiagnosticEvent(
      "API-Route",
      `Fallback-first response was not successful; route=${diagnosticRoute}, status=${validated.status}; trying primary`,
      "W",
    );
  } catch (fallbackError) {
    if (userSignal?.aborted) throw fallbackError;
    recordDiagnosticEvent(
      "API-Route",
      `Fallback-first transport failed; route=${diagnosticRoute}; trying primary`,
      "W",
    );
  }

  try {
    const response = await attemptFetch(primaryUrl, primaryInit, PRIMARY_TIMEOUT_MS, userSignal);
    primaryUnavailableUntil = 0;
    recordDiagnosticEvent(
      "API-Route",
      `Primary route answered after fallback-first retry; route=${diagnosticRoute}, status=${response.status}`,
      response.ok ? "D" : "W",
    );
    return response;
  } catch (primaryError) {
    if (userSignal?.aborted) throw primaryError;
    if (rejectedFallbackResponse) return rejectedFallbackResponse;
    throw primaryError;
  }
}

async function hedgedGetFetch(
  primaryUrl: string,
  fallbackUrl: string,
  primaryInit: RequestInit,
  fallbackInit: RequestInit,
  userSignal: AbortSignal | null | undefined,
  waitForOkResponse = false,
  diagnosticRoute = "other",
): Promise<Response> {
  type HedgedResponse = {
    source: "primary" | "fallback";
    response: Response;
  };

  const primaryController = new AbortController();
  const fallbackController = new AbortController();
  let rejectedPrimaryResponse: Response | null = null;
  let rejectedFallbackResponse: Response | null = null;
  if (userSignal) {
    const abortBoth = () => {
      primaryController.abort();
      fallbackController.abort();
    };
    if (userSignal.aborted) abortBoth();
    else userSignal.addEventListener("abort", abortBoth, { once: true });
  }

  const primaryPromise: Promise<HedgedResponse> = attemptFetch(
    primaryUrl,
    primaryInit,
    PRIMARY_TIMEOUT_MS,
    primaryController.signal,
  ).then((response) => {
    // A completed HTTP request is not necessarily a usable response.  In
    // particular the fallback gateway can answer with a fast 404/429 while
    // the (slightly slower) primary is about to return the requested data.
    // Treating that first non-2xx response as the hedge winner made binary
    // endpoints such as /api/user/avatar disappear intermittently.
    if (response.status === FALLBACK_HTTP_STATUS || (waitForOkResponse && !response.ok)) {
      rejectedPrimaryResponse = response;
      throw new Error(`Primary route returned HTTP ${response.status}`);
    }
    return { source: "primary" as const, response };
  });
  const fallbackPromise: Promise<HedgedResponse> = (async () => {
    await delayMs(FALLBACK_HEDGE_DELAY_MS);
    const response = await attemptFetch(
      fallbackUrl,
      fallbackInit,
      FALLBACK_TIMEOUT_MS,
      fallbackController.signal,
    );
    const validated = await rejectProxyGatewayAuthError(response);
    // Never let a non-2xx response from the fallback win the hedge. The
    // primary response remains authoritative; the rejected fallback is only
    // returned later when the primary route itself cannot produce a response.
    if (!validated.ok) {
      rejectedFallbackResponse = validated;
      throw new Error(`Fallback route returned HTTP ${validated.status}`);
    }
    return validated;
  })().then((response) => ({ source: "fallback" as const, response }));

  try {
    const winner = await firstSuccessful([primaryPromise, fallbackPromise]);
    if (winner.source === "primary") {
      fallbackController.abort();
      primaryUnavailableUntil = 0;
    } else {
      primaryController.abort();
      // A non-2xx primary still proves that the primary route is reachable;
      // only prefer the fallback for later requests when the primary did not
      // produce an HTTP response at all (network failure/timeout).
      primaryUnavailableUntil = waitForOkResponse && rejectedPrimaryResponse
        ? 0
        : performance.now() + PRIMARY_FAILURE_COOLDOWN_MS;
      recordDiagnosticEvent(
        "API-Route",
        `Fallback route won delayed request; route=${diagnosticRoute}`,
        "D",
      );
    }
    return winner.response;
  } catch {
    primaryController.abort();
    fallbackController.abort();
    primaryUnavailableUntil = waitForOkResponse && rejectedPrimaryResponse
      ? 0
      : performance.now() + PRIMARY_FAILURE_COOLDOWN_MS;
    if (rejectedPrimaryResponse) return rejectedPrimaryResponse;
    if (rejectedFallbackResponse) return rejectedFallbackResponse;
    throw new Error("Network request failed");
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

async function performFetchRoute(
  path: string,
  init: RequestInit = {},
  query?: Record<string, string | number | undefined>,
  options: { waitForOkHedge?: boolean } = {},
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
  const diagnosticRoute = diagnosticApiRoute(path);

  // Endpoints that explicitly require a successful response must not inherit
  // the global fallback-first cooldown. The fallback proxy can legitimately
  // lack a newer/account-specific route (for example purchase plans) and
  // answer quickly with 400 while the healthy primary would return the data.
  // Keep the primary + fallback hedge for those requests so a stale cooldown
  // from an unrelated endpoint cannot hide tariffs or the user avatar.
  if (
    fallbackUrl &&
    isSafeMethod &&
    options.waitForOkHedge !== true &&
    primaryUnavailableUntil > performance.now()
  ) {
    return fallbackFirstFetch(
      primaryUrl,
      fallbackUrl,
      primaryInit,
      fallbackInit,
      userSignal,
      diagnosticRoute,
    );
  }

  if (fallbackUrl && isSafeMethod) {
    return hedgedGetFetch(
      primaryUrl,
      fallbackUrl,
      primaryInit,
      fallbackInit,
      userSignal,
      options.waitForOkHedge === true,
      diagnosticRoute,
    );
  }

  try {
    return await attemptFetch(
      primaryUrl,
      primaryInit,
      BOT_API_FALLBACK_URL ? PRIMARY_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      userSignal,
    );
  } catch (primaryError) {
    // Retrying a state-changing request can duplicate an unlink, purchase,
    // or registration when the primary committed it but its response was lost.
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

async function performFetch(
  path: string,
  init: RequestInit = {},
  query?: Record<string, string | number | undefined>,
  options: { waitForOkHedge?: boolean } = {},
): Promise<Response> {
  const startedAt = performance.now();
  const route = diagnosticApiRoute(path);
  const method = (init.method ?? "GET").toUpperCase();
  try {
    const response = await performFetchRoute(path, init, query, options);
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (!response.ok) {
      recordDiagnosticEvent(
        "API",
        `Request returned an error; route=${route}, method=${method}, status=${response.status}, elapsed_ms=${elapsedMs}`,
        "W",
      );
    } else if (elapsedMs >= 3_000) {
      recordDiagnosticEvent(
        "API",
        `Request completed slowly; route=${route}, method=${method}, status=${response.status}, elapsed_ms=${elapsedMs}`,
        "D",
      );
    }
    return response;
  } catch (error) {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    const reason = diagnosticRequestFailure(error, init.signal);
    recordDiagnosticEvent(
      "API",
      `Request failed before a response; route=${route}, method=${method}, reason=${reason}, elapsed_ms=${elapsedMs}`,
      reason === "cancelled" ? "D" : "W",
    );
    throw error;
  }
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

async function parseErrorMessage(response: Response): Promise<string> {
  // Cap the surfaced error message length so a hostile/buggy backend payload
  // can't blow up the UI layout. React already escapes the text — no XSS — but
  // multi-MB error bodies or multi-line markdown break the layout.
  try {
    const text = await response.text();
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

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiHttpError(response.status, await parseErrorMessage(response));
  }
  return (await response.json()) as T;
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
  if (getSessionGeneration() !== generation) {
    throw new Error("Device session changed while bootstrap was in flight");
  }
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
  fetchOptions: { waitForOkHedge?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  let accessToken: string | null = null;
  const requestGeneration = authMode === "access" ? getSessionGeneration() : null;
  const assertSessionIsCurrent = () => {
    if (requestGeneration !== null && getSessionGeneration() !== requestGeneration) {
      throw new Error("Device session changed while request was in flight");
    }
  };

  if (authMode === "access") {
    accessToken = await getAccessTokenForRequest();
    assertSessionIsCurrent();
    if (accessToken) {
      headers.set(DIRECT_AUTH_HEADER, `Bearer ${accessToken}`);
    }
  }

  const response = await performFetch(path, { ...init, headers }, query, fetchOptions);
  assertSessionIsCurrent();
  const method = (init.method ?? "GET").toUpperCase();
  if (
    isInvalidSessionStatus(response.status) &&
    authMode === "access" &&
    retryOnAuthFailure
  ) {
    const recoveredToken = await recoverAccessTokenAfter401(accessToken);
    assertSessionIsCurrent();
    if (recoveredToken && (method === "GET" || method === "HEAD")) {
      return request(path, init, query, authMode, false, fetchOptions);
    }
  }

  const payload = await expectJson<T>(response);
  assertSessionIsCurrent();
  return payload;
}

// --- User avatar ---

// Fetches the current user's Telegram avatar (binary JPEG from
// GET /api/user/avatar, same endpoint the Android client uses). Returns the
// image bytes as a Blob, or null when the user has no photo. Request failures
// throw so a temporary auth/network problem is not cached as an absent photo.
// The endpoint is rate-limited, so callers should cache a successful result
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

  let response = await performFetch(
    "api/user/avatar",
    { method: "GET", headers },
    undefined,
    { waitForOkHedge: true },
  );
  assertSessionIsCurrent();
  if (isInvalidSessionStatus(response.status)) {
    const recovered = await recoverAccessTokenAfter401(accessToken);
    assertSessionIsCurrent();
    if (recovered) {
      const retryHeaders = new Headers();
      retryHeaders.set(DIRECT_AUTH_HEADER, `Bearer ${recovered}`);
      response = await performFetch(
        "api/user/avatar",
        { method: "GET", headers: retryHeaders },
        undefined,
        { waitForOkHedge: true },
      );
      assertSessionIsCurrent();
    }
  }

  // A missing photo is a valid empty result. Authentication/server failures
  // must stay retryable: caching every non-2xx response as "no avatar" made
  // the image remain absent when Settings mounted a moment before the secure
  // access token had finished loading.
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Avatar request failed with HTTP ${response.status}`);
  }
  // Match the Android client: the endpoint returns raw JPEG bytes, but the
  // Content-Type can be generic (e.g. application/octet-stream). Read the
  // bytes and re-wrap them as image/jpeg so the object URL renders in <img>
  // regardless of the server's declared type. A broken/HTML body still just
  // fails to decode and the UI falls back to the placeholder via onError.
  const bytes = await response.arrayBuffer();
  assertSessionIsCurrent();
  if (bytes.byteLength === 0) return null;
  return new Blob([bytes], { type: "image/jpeg" });
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
  return request("api/auth/status", { method: "GET" }, { token }, "none");
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

// --- Referrals ---

export function getReferrals(
  limit = 20,
  offset = 0,
): Promise<ApiResponse<ReferralsDto>> {
  return request("api/referrals", { method: "GET" }, { limit, offset });
}

export function setReferrer(
  req: SetReferrerRequestDto,
): Promise<ApiResponse<SetReferrerResponseDto>> {
  return request("api/device/referrer", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// --- Promocodes ---

export function getAppliedPromocodes(
  limit = 20,
  offset = 0,
): Promise<ApiResponse<PromocodeHistoryDto>> {
  return request("api/user/promocodes", { method: "GET" }, { limit, offset });
}

export function activatePromocode(
  req: PromocodeActivateRequestDto,
): Promise<ApiResponse<PromocodeActivationResultDto>> {
  return request("api/user/promocodes/activate", {
    method: "POST",
    body: JSON.stringify(req),
  });
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
  return request("api/tv/pair/status", { method: "GET" }, { code }, "none");
}

// --- Panel proxy ---

export function getUserByTelegramId(
  telegramId: number,
): Promise<PanelResponse<PanelUserDto[]>> {
  return request(`api/panel/user-by-telegram/${telegramId}`, { method: "GET" });
}

export function getNodes(): Promise<PanelResponse<PanelNodeDto[]>> {
  return request("api/panel/nodes", { method: "GET" });
}

export function getCurrentPlan(): Promise<ApiResponse<CurrentPlanDto>> {
  // The current-plan payload feeds the limits shown above the tariff list.
  // Like purchase plans, this is an account-specific route that may not yet
  // exist on the fallback proxy. Never let a cached fallback-first decision
  // replace a valid primary response with placeholder limits.
  return request(
    "api/subscription/current-plan",
    { method: "GET" },
    undefined,
    "access",
    true,
    { waitForOkHedge: true },
  );
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
  // Prices are account-specific and a fast non-2xx response from the backup
  // gateway must not beat a valid (slightly slower) primary response.
  return request(
    "api/purchase/plans",
    { method: "GET" },
    undefined,
    "access",
    true,
    { waitForOkHedge: true },
  );
}
