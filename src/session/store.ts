// Persistent session for the desktop client.
// Holds the stable install-scoped deviceId, per-device auth tokens, and linked user identity.
import { useSyncExternalStore } from "react";
import type { SessionTokensDto } from "../api/types";

export type UserPlan = "FREE_TRIAL" | "PAID" | "ADMIN" | "EXPIRED";

export interface Session {
  deviceId: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  isLinked: boolean;
  telegramId: number | null;
  shortUuid: string | null;
  panelUserUuid: string | null;
  userPlan: UserPlan;
  planDisplayName: string | null;
  planExpiresAt: number | null;
  isAdminProfile: boolean;
  trafficLimitBytes: number;
  trafficUsedBytes: number;
  email: string | null;
}

export interface SessionSecrets {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

const STORAGE_KEY = "tobevpn_session_v2";
const LEGACY_STORAGE_KEY = "tobevpn_session_v1";

function generateDeviceId(): string {
  // RFC4122 v4 — crypto is available in modern Tauri webviews.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto & { randomUUID(): string }).randomUUID();
  }
  // Fallback (shouldn't normally hit this branch).
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}

function defaultSession(): Session {
  return {
    deviceId: generateDeviceId(),
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    isLinked: false,
    telegramId: null,
    shortUuid: null,
    panelUserUuid: null,
    userPlan: "FREE_TRIAL",
    planDisplayName: null,
    planExpiresAt: null,
    isAdminProfile: false,
    trafficLimitBytes: 0,
    trafficUsedBytes: 0,
    email: null,
  };
}

function migrateSession(parsed: Partial<Session>): Session {
  const defaults = defaultSession();
  const merged: Session = { ...defaults, ...parsed };
  if (typeof merged.deviceId !== "string" || !merged.deviceId.trim()) {
    merged.deviceId = defaults.deviceId;
  }
  if (parsed.isLinked === undefined) {
    merged.isLinked = parsed.telegramId !== null && parsed.telegramId !== undefined;
  }
  merged.isAdminProfile = parsed.isAdminProfile === true;
  return merged;
}

function load(): Session {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Session>;
      const merged = migrateSession(parsed);
      // Keep legacy credentials in memory long enough for initializeAuthSession
      // to migrate them, but remove the plaintext copy before any async work.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeForStorage(merged)));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return merged;
    }
  } catch {
    // ignore — fall through to fresh session
  }
  const fresh = defaultSession();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    // storage may be unavailable in some contexts
  }
  return fresh;
}

let current: Session = load();
let sessionGeneration = 0;
const listeners = new Set<() => void>();

function sanitizeForStorage(session: Session): Session {
  return {
    ...session,
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeForStorage(current)));
  } catch {
    // ignore
  }
}

function notify() {
  for (const fn of listeners) fn();
}

export function getSession(): Session {
  return current;
}

export function getSessionGeneration(): number {
  return sessionGeneration;
}

export function invalidateSessionWork(): void {
  sessionGeneration += 1;
}

export function updateSession(patch: Partial<Session>): Session {
  current = { ...current, ...patch };
  persist();
  notify();
  return current;
}

export function clearIdentity() {
  // Keep deviceId and device-session tokens so the same install can re-pair
  // without forcing a fresh bootstrap after a remote unlink.
  invalidateSessionWork();
  updateSession({
    isLinked: false,
    telegramId: null,
    shortUuid: null,
    panelUserUuid: null,
    userPlan: "FREE_TRIAL",
    planDisplayName: null,
    planExpiresAt: null,
    isAdminProfile: false,
    trafficLimitBytes: 0,
    trafficUsedBytes: 0,
    email: null,
  });
}

export function clearSessionTokens() {
  invalidateSessionWork();
  updateSession({
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  });
}

export function clearDeviceSession() {
  // Explicit logout: keep install-scoped deviceId, drop device-session tokens and linked identity.
  invalidateSessionWork();
  updateSession({
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    isLinked: false,
    telegramId: null,
    shortUuid: null,
    panelUserUuid: null,
    userPlan: "FREE_TRIAL",
    planDisplayName: null,
    planExpiresAt: null,
    isAdminProfile: false,
    trafficLimitBytes: 0,
    trafficUsedBytes: 0,
    email: null,
  });
}

export function getSessionSecrets(s: Session = current): SessionSecrets | null {
  if (
    typeof s.accessToken !== "string" ||
    typeof s.refreshToken !== "string" ||
    typeof s.accessTokenExpiresAt !== "number" ||
    typeof s.refreshTokenExpiresAt !== "number"
  ) {
    return null;
  }
  return {
    deviceId: s.deviceId,
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    accessTokenExpiresAt: s.accessTokenExpiresAt,
    refreshTokenExpiresAt: s.refreshTokenExpiresAt,
  };
}

export function applySessionSecrets(secrets: SessionSecrets | null): Session {
  if (!secrets) {
    return updateSession({
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  }
  return updateSession({
    deviceId: secrets.deviceId,
    accessToken: secrets.accessToken,
    refreshToken: secrets.refreshToken,
    accessTokenExpiresAt: secrets.accessTokenExpiresAt,
    refreshTokenExpiresAt: secrets.refreshTokenExpiresAt,
  });
}

export function updateSessionFromTokens(tokens: SessionTokensDto): Session {
  if (
    typeof tokens.access_token !== "string" ||
    !tokens.access_token.trim() ||
    tokens.access_token.length > 16 * 1024 ||
    /[\u0000-\u001f\u007f]/.test(tokens.access_token) ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token.trim() ||
    tokens.refresh_token.length > 16 * 1024 ||
    /[\u0000-\u001f\u007f]/.test(tokens.refresh_token) ||
    !Number.isSafeInteger(tokens.expires_in) ||
    tokens.expires_in <= 0 ||
    tokens.expires_in > 10 * 365 * 24 * 60 * 60 ||
    !Number.isSafeInteger(tokens.refresh_expires_in) ||
    tokens.refresh_expires_in <= 0 ||
    tokens.refresh_expires_in > 10 * 365 * 24 * 60 * 60
  ) {
    throw new Error("Server returned invalid session tokens");
  }
  const currentSession = getSession();
  const now = Date.now();
  const tokenDeviceId =
    typeof tokens.device_id === "string" &&
    tokens.device_id.trim() &&
    tokens.device_id.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(tokens.device_id)
      ? tokens.device_id.trim()
      : currentSession.deviceId;
  const tokenTelegramId =
    Number.isSafeInteger(tokens.telegram_id) && (tokens.telegram_id ?? 0) > 0
      ? tokens.telegram_id
      : null;
  const tokenIsLinked = Boolean(
    tokens.is_linked === true && tokenTelegramId !== null,
  );
  const boundedIdentity = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed &&
      trimmed.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(trimmed)
      ? trimmed
      : null;
  };
  const preserveLinkedIdentity = currentSession.isLinked && !tokenIsLinked;
  const isLinked = tokenIsLinked || preserveLinkedIdentity;
  return updateSession({
    deviceId: tokenDeviceId,
    accessToken: tokens.access_token.trim(),
    refreshToken: tokens.refresh_token.trim(),
    accessTokenExpiresAt: now + tokens.expires_in * 1000,
    refreshTokenExpiresAt: now + tokens.refresh_expires_in * 1000,
    isLinked,
    telegramId: tokenIsLinked
      ? tokenTelegramId
      : (isLinked ? currentSession.telegramId : null),
    shortUuid: tokenIsLinked
      ? (boundedIdentity(tokens.short_uuid) ?? currentSession.shortUuid)
      : (isLinked ? currentSession.shortUuid : null),
    panelUserUuid: tokenIsLinked
      ? (boundedIdentity(tokens.panel_user_uuid) ?? currentSession.panelUserUuid)
      : (isLinked ? currentSession.panelUserUuid : null),
    userPlan: isLinked ? currentSession.userPlan : "FREE_TRIAL",
    planDisplayName: isLinked ? currentSession.planDisplayName : null,
    planExpiresAt: isLinked ? currentSession.planExpiresAt : null,
    isAdminProfile: isLinked ? currentSession.isAdminProfile : false,
    trafficLimitBytes: isLinked ? currentSession.trafficLimitBytes : 0,
    trafficUsedBytes: isLinked ? currentSession.trafficUsedBytes : 0,
    email: isLinked ? currentSession.email : null,
  });
}

export function markLinkedIdentity(identity: {
  telegramId: number;
  shortUuid?: string | null;
  panelUserUuid?: string | null;
}): Session {
  if (!Number.isSafeInteger(identity.telegramId) || identity.telegramId <= 0) {
    throw new Error("Invalid Telegram identity");
  }
  const currentSession = getSession();
  const sameIdentity =
    currentSession.isLinked && currentSession.telegramId === identity.telegramId;
  const boundedIdentity = (value: string | null | undefined): string | null => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed &&
      trimmed.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(trimmed)
      ? trimmed
      : null;
  };
  const nextShortUuid =
    boundedIdentity(identity.shortUuid) ?? (sameIdentity ? currentSession.shortUuid : null);
  const nextPanelUserUuid =
    boundedIdentity(identity.panelUserUuid) ??
    (sameIdentity ? currentSession.panelUserUuid : null);
  if (
    !currentSession.isLinked ||
    currentSession.telegramId !== identity.telegramId ||
    nextShortUuid !== currentSession.shortUuid ||
    nextPanelUserUuid !== currentSession.panelUserUuid
  ) {
    invalidateSessionWork();
  }
  return updateSession({
    isLinked: true,
    telegramId: identity.telegramId,
    shortUuid: nextShortUuid,
    panelUserUuid: nextPanelUserUuid,
    userPlan: sameIdentity ? currentSession.userPlan : "FREE_TRIAL",
    planDisplayName: sameIdentity ? currentSession.planDisplayName : null,
    planExpiresAt: sameIdentity ? currentSession.planExpiresAt : null,
    isAdminProfile: sameIdentity ? currentSession.isAdminProfile : false,
    trafficLimitBytes: sameIdentity ? currentSession.trafficLimitBytes : 0,
    trafficUsedBytes: sameIdentity ? currentSession.trafficUsedBytes : 0,
    email: sameIdentity ? currentSession.email : null,
  });
}

export function isPaired(s: Session = current): boolean {
  return s.isLinked;
}

export function hasValidAccessToken(s: Session = current): boolean {
  return (
    typeof s.accessToken === "string" &&
    typeof s.accessTokenExpiresAt === "number" &&
    s.accessTokenExpiresAt - Date.now() > 5_000
  );
}

export function hasValidRefreshToken(s: Session = current): boolean {
  return (
    typeof s.refreshToken === "string" &&
    typeof s.refreshTokenExpiresAt === "number" &&
    s.refreshTokenExpiresAt - Date.now() > 5_000
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Public, non-React-hook subscription to session changes. Useful for
 * non-component code (e.g. the VPN runtime that needs to react to plan
 * transitions) that can't call useSession.
 */
export function subscribeSession(listener: (session: Session) => void): () => void {
  return subscribe(() => listener(current));
}

export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSession, getSession);
}
