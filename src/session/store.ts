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
  planExpiresAt: number | null;
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
    planExpiresAt: null,
    trafficLimitBytes: 0,
    trafficUsedBytes: 0,
    email: null,
  };
}

function migrateSession(parsed: Partial<Session>): Session {
  const merged: Session = { ...defaultSession(), ...parsed };
  if (parsed.isLinked === undefined) {
    merged.isLinked = parsed.telegramId !== null && parsed.telegramId !== undefined;
  }
  return merged;
}

function load(): Session {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Session>;
      const merged = migrateSession(parsed);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
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

export function updateSession(patch: Partial<Session>): Session {
  current = { ...current, ...patch };
  persist();
  notify();
  return current;
}

export function clearIdentity() {
  // Keep deviceId and device-session tokens so the same install can re-pair
  // without forcing a fresh bootstrap after a remote unlink.
  updateSession({
    isLinked: false,
    telegramId: null,
    shortUuid: null,
    panelUserUuid: null,
    userPlan: "FREE_TRIAL",
    planExpiresAt: null,
    trafficLimitBytes: 0,
    trafficUsedBytes: 0,
    email: null,
  });
}

export function clearDeviceSession() {
  // Explicit logout: keep install-scoped deviceId, drop device-session tokens and linked identity.
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
    planExpiresAt: null,
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
  const currentSession = getSession();
  const now = Date.now();
  const isLinked = Boolean(tokens.is_linked && tokens.telegram_id !== null && tokens.telegram_id !== undefined);
  return updateSession({
    deviceId: tokens.device_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: now + tokens.expires_in * 1000,
    refreshTokenExpiresAt: now + tokens.refresh_expires_in * 1000,
    isLinked,
    telegramId: isLinked ? (tokens.telegram_id ?? null) : null,
    shortUuid: isLinked ? (tokens.short_uuid ?? currentSession.shortUuid) : null,
    panelUserUuid: isLinked ? (tokens.panel_user_uuid ?? currentSession.panelUserUuid) : null,
    userPlan: isLinked ? currentSession.userPlan : "FREE_TRIAL",
    planExpiresAt: isLinked ? currentSession.planExpiresAt : null,
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
  const currentSession = getSession();
  return updateSession({
    isLinked: true,
    telegramId: identity.telegramId,
    shortUuid: identity.shortUuid ?? currentSession.shortUuid,
    panelUserUuid: identity.panelUserUuid ?? currentSession.panelUserUuid,
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

export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSession, getSession);
}
