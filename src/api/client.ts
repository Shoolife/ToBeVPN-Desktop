// Thin fetch wrapper for the bot backend using per-device sessions.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { BOT_API_BASE_URL, BOT_API_FALLBACK_URL, CONTROL_PLANE_BYPASS_HOSTS } from "./config";
import { getDeviceFingerprint } from "../session/fingerprint";
import {
  clearSessionTokens,
  getSession,
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

let tokenOperation: Promise<string | null> | null = null;
let primaryUnavailableUntil = 0;

function publicErrorMessage(raw: string): string {
  let message = raw
    .replace(/https?:\/\/[^\s)]+/gi, "[configured endpoint]")
    .replace(/[\n\r\t]+/g, " ")
    .trim();
  for (const hostname of CONTROL_PLANE_BYPASS_HOSTS) {
    message = message.split(hostname).join("[configured host]");
  }
  return message.slice(0, 200);
}

function runTokenOperation(
  operation: () => Promise<string | null>,
): Promise<string | null> {
  if (tokenOperation) return tokenOperation;
  tokenOperation = operation().finally(() => {
    tokenOperation = null;
  });
  return tokenOperation;
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
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort();
    } else {
      userSignal.addEventListener("abort", () => controller.abort(), { once: true });
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
  try {
    const response = await attemptFetch(fallbackUrl, fallbackInit, FALLBACK_TIMEOUT_MS, userSignal);
    return await rejectProxyGatewayAuthError(response);
  } catch (fallbackError) {
    if (userSignal?.aborted) throw fallbackError;
    const response = await attemptFetch(primaryUrl, primaryInit, PRIMARY_TIMEOUT_MS, userSignal);
    primaryUnavailableUntil = 0;
    return response;
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
    if (response.status === FALLBACK_HTTP_STATUS) {
      rejectedPrimaryResponse = response;
      throw new Error("Primary route rejected request");
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
    return await rejectProxyGatewayAuthError(response);
  })().then((response) => ({ source: "fallback" as const, response }));

  try {
    const winner = await firstSuccessful([primaryPromise, fallbackPromise]);
    if (winner.source === "primary") {
      fallbackController.abort();
      primaryUnavailableUntil = 0;
    } else {
      primaryController.abort();
      primaryUnavailableUntil = Date.now() + PRIMARY_FAILURE_COOLDOWN_MS;
    }
    return winner.response;
  } catch {
    primaryUnavailableUntil = Date.now() + PRIMARY_FAILURE_COOLDOWN_MS;
    if (rejectedPrimaryResponse) return rejectedPrimaryResponse;
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

  if (fallbackUrl && primaryUnavailableUntil > Date.now()) {
    return fallbackFirstFetch(primaryUrl, fallbackUrl, primaryInit, fallbackInit, userSignal);
  }

  if (fallbackUrl && (method === "GET" || method === "HEAD")) {
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
    if (!BOT_API_FALLBACK_URL) throw primaryError;
    if (userSignal?.aborted) throw primaryError;
    console.warn(`[bot-api] primary request to ${path} failed, retrying via fallback`);
    if (!fallbackUrl) throw primaryError;
    primaryUnavailableUntil = Date.now() + PRIMARY_FAILURE_COOLDOWN_MS;
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
  updateSessionFromTokens(payload.data);
  await persistCurrentSessionSecrets();
  return payload.data;
}

export async function bootstrapDeviceSession(): Promise<void> {
  await bootstrapDeviceSessionInternal();
}

async function refreshDeviceSessionInternal(refreshToken: string): Promise<SessionTokensDto> {
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

  if (authMode === "access") {
    accessToken = await getAccessTokenForRequest();
    if (accessToken) {
      headers.set(DIRECT_AUTH_HEADER, `Bearer ${accessToken}`);
    }
  }

  const response = await performFetch(path, { ...init, headers }, query);
  if (
    isInvalidSessionStatus(response.status) &&
    authMode === "access" &&
    retryOnAuthFailure
  ) {
    const recoveredToken = await recoverAccessTokenAfter401(accessToken);
    if (recoveredToken) {
      return request(path, init, query, authMode, false);
    }
  }

  return expectJson<T>(response);
}

// --- User avatar ---

// Fetches the current user's Telegram avatar (binary JPEG from
// GET /api/user/avatar, same endpoint the Android client uses). Returns the
// image bytes as a Blob, or null when the user has no photo / the request
// fails. The endpoint is rate-limited, so callers should cache the result
// for the app session instead of re-fetching on every screen open.
export async function fetchUserAvatar(): Promise<Blob | null> {
  const headers = new Headers();
  const accessToken = await getAccessTokenForRequest();
  if (accessToken) headers.set(DIRECT_AUTH_HEADER, `Bearer ${accessToken}`);

  let response = await performFetch("api/user/avatar", { method: "GET", headers });
  if (isInvalidSessionStatus(response.status)) {
    const recovered = await recoverAccessTokenAfter401(accessToken);
    if (recovered) {
      const retryHeaders = new Headers();
      retryHeaders.set(DIRECT_AUTH_HEADER, `Bearer ${recovered}`);
      response = await performFetch("api/user/avatar", { method: "GET", headers: retryHeaders });
    }
  }

  if (!response.ok) return null;
  const blob = await response.blob();
  return blob.size > 0 ? blob : null;
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
