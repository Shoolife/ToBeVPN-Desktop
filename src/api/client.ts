// Thin fetch wrapper for the bot backend using per-device sessions.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { BOT_API_BASE_URL, BOT_API_FALLBACK_URL } from "./config";
import { getDeviceFingerprint } from "../session/fingerprint";
import {
  clearDeviceSession,
  getSession,
  hasValidAccessToken,
  hasValidRefreshToken,
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
  DeviceRegisterRequestDto,
  DeviceUnlinkRequestDto,
  LinkedDevicesDto,
  PanelNodeDto,
  PanelResponse,
  PanelSubInfoDto,
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

let tokenOperation: Promise<string | null> | null = null;

function runTokenOperation(
  operation: () => Promise<string | null>,
): Promise<string | null> {
  if (tokenOperation) return tokenOperation;
  tokenOperation = operation().finally(() => {
    tokenOperation = null;
  });
  return tokenOperation;
}

// Single attempt against one base URL with its own abort controller. Lifting
// this out of performFetch lets us fire two attempts (primary then fallback)
// each with its own timeout while still honouring the caller's abort signal.
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
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
  const baseInit: RequestInit = { ...init, headers };

  try {
    return await attemptFetch(
      buildUrl(path, query, BOT_API_BASE_URL),
      baseInit,
      BOT_API_FALLBACK_URL ? PRIMARY_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      userSignal,
    );
  } catch (primaryError) {
    if (!BOT_API_FALLBACK_URL) throw primaryError;
    if (userSignal?.aborted) throw primaryError;
    console.warn(
      `[bot-api] primary request to ${path} failed, retrying via fallback:`,
      primaryError,
    );
    const fallbackUrl = buildFallbackBotUrl(path, query, BOT_API_FALLBACK_URL);
    if (!fallbackUrl) throw primaryError;
    return await attemptFetch(
      fallbackUrl,
      baseInit,
      FALLBACK_TIMEOUT_MS,
      userSignal,
    );
  }
}

async function parseErrorMessage(response: Response): Promise<string> {
  // Cap the surfaced error message length so a hostile/buggy backend payload
  // can't blow up the UI layout. React already escapes the text — no XSS — but
  // multi-MB error bodies or multi-line markdown break the layout.
  const sanitize = (raw: string): string =>
    raw.replace(/[\n\r\t]+/g, " ").trim().slice(0, 200);
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string; detail?: string };
      if (typeof parsed.message === "string" && parsed.message.trim())
        return sanitize(parsed.message);
      if (typeof parsed.detail === "string" && parsed.detail.trim())
        return sanitize(parsed.detail);
    } catch {
      // Not JSON — fall back to raw text.
    }
    return sanitize(text);
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as T;
}

async function bootstrapDeviceSessionInternal(): Promise<SessionTokensDto> {
  const session = getSession();
  const requestBody: BootstrapRequestDto = {
    device_id: session.deviceId,
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
      }
    }

    const bootstrapped = await bootstrapDeviceSessionInternal();
    return bootstrapped.access_token;
  });
}

export async function syncDeviceSessionState(): Promise<void> {
  await runTokenOperation(async () => {
    const current = getSession();

    if (current.refreshToken) {
      try {
        const refreshed = await refreshDeviceSessionInternal(current.refreshToken);
        return refreshed.access_token;
      } catch (error) {
        console.warn("[device-session] refresh state sync failed:", error);
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
        await clearSecureSession();
        clearDeviceSession();
      }
    }

    try {
      const bootstrapped = await bootstrapDeviceSessionInternal();
      return bootstrapped.access_token;
    } catch (error) {
      console.warn("[device-session] bootstrap after 401 failed:", error);
      await clearSecureSession();
      clearDeviceSession();
      return null;
    }
  });
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  query?: Record<string, string | number | undefined>,
  authMode: AuthMode = "access",
  retryOn401 = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  let accessToken: string | null = null;

  if (authMode === "access") {
    accessToken = await getAccessTokenForRequest();
    if (accessToken) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
  }

  const response = await performFetch(path, { ...init, headers }, query);
  if (response.status === 401 && authMode === "access" && retryOn401) {
    const recoveredToken = await recoverAccessTokenAfter401(accessToken);
    if (recoveredToken) {
      return request(path, init, query, authMode, false);
    }
  }

  return expectJson<T>(response);
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

export function unlinkDevice(req: DeviceUnlinkRequestDto): Promise<ApiResponse<unknown>> {
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

export function getSubscriptionInfo(
  shortUuid: string,
): Promise<PanelResponse<PanelSubInfoDto>> {
  return request(`api/panel/sub/${shortUuid}/info`, { method: "GET" });
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
