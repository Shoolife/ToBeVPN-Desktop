// Higher-level operations on top of the API client + local session.
// Mirrors the Kotlin AuthRepository on the TV/phone clients.
import {
  ApiHttpError,
  bootstrapDeviceSession,
  checkAuthStatus,
  checkTvPairingStatus,
  createTvPairing,
  ensureDeviceSession,
  getCurrentPlan,
  getDevices as apiGetDevices,
  getNodes as apiGetNodes,
  getPurchasePlans as apiGetPurchasePlans,
  getUserByTelegramId,
  logoutDevice,
  requestAuth,
  registerDevice,
  saveEmail as apiSaveEmail,
  unlinkDevice,
} from "../api/client";
import type {
  AuthStatusDto,
  CurrentPlanDto,
  DeviceUnlinkResponseDto,
  LinkedDevicesDto,
  PanelNodeDto,
  PanelUserDto,
  PurchasePlansDto,
  TvPairStatusDto,
} from "../api/types";
import {
  clearIdentity,
  clearDeviceSession,
  applySessionSecrets,
  getSession,
  getSessionGeneration,
  getSessionSecrets,
  invalidateSessionWork,
  markLinkedIdentity,
  subscribeSession,
  updateSession,
  type Session,
  type UserPlan,
} from "./store";
import {
  clearSecureSession,
  loadSecureSession,
  saveSecureSession,
} from "./secureSession";
import {
  disconnectVpn,
  getActiveVpnReconnectServer,
  getVpnConnectionGeneration,
  reconnectVpnWithFreshSubscription,
} from "./vpnState";
import { isBrowserPreviewRuntime } from "./browserPreview";
import {
  fetchSubscriptionProfile,
  pingSubscriptionUrl,
  type SubscriptionProfileResult,
} from "./subscriptionPinger";
import { getDeviceFingerprint } from "./fingerprint";

const DEVICE_TYPE = "desktop";
const PLATFORM = "Desktop";
const STARTUP_SESSION_TIMEOUT_MS = 4_500;
const STARTUP_SUBSCRIPTION_TIMEOUT_MS = 4_500;
const TELEGRAM_BOT_NAME = "meow_meow_vpn_bot";

let cachedHostname: string | null = null;

// Subscription refresh throttling. The interval comes from the panel's
// `profile-update-interval` header (read by pingSubscriptionUrl); we cache
// it in localStorage along with the last successful sync so quick re-mounts
// of the home/server screens don't each trigger their own panel hit.
const SUB_SYNC_AT_KEY = "tobevpn_sub_sync_at_v1";
const SUB_INTERVAL_KEY = "tobevpn_sub_interval_ms_v1";
const LEGACY_SUB_URL_CACHE_KEY = "tobevpn_subscription_url_v1";
const SUB_URL_CACHE_KEY = "tobevpn_subscription_url_v2";
const BLOCKED_SUBSCRIPTION_KEY = "tobevpn_blocked_subscription_v1";
// A forced-update decision belongs to the installed build. Changing the key
// with the app version prevents an already-updated client from inheriting the
// previous build's persisted block before its first subscription refresh.
const UPDATE_REQUIRED_KEY = `tobevpn_minimum_version_required_${__APP_VERSION__}`;
const SUBSCRIPTION_ACCESS_EVENT = "tobevpn:subscription-access-changed";
const LEGACY_PENDING_PURCHASE_KEY = "tobevpn_pending_purchase_v1";
const PENDING_PURCHASE_KEY = "tobevpn_pending_purchase_v2";
const PENDING_AUTH_TOKEN_KEY = "tobevpn_pending_auth_token_v1";
const VPN_SERVERS_EVENT = "tobevpn:vpn-servers-changed";
// 12h matches the default surfaced in the panel's "subscription
// auto-refresh" panel field. Used until the first successful ping
// returns a `profile-update-interval` value.
const DEFAULT_SUB_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MIN_SUB_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SUB_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const PERSISTED_TIMESTAMP_FUTURE_TOLERANCE_MS = 60_000;
const MAX_PENDING_AUTH_TOKEN_LENGTH = 2_048;

const PURCHASE_REFRESH_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const PURCHASE_REFRESH_TOTAL_WINDOW_MS = 10 * 60 * 1000;
const PURCHASE_REFRESH_INTERVAL_MS = 3_000;
const PURCHASE_REFRESH_SLOW_INTERVAL_MS = 30_000;
const PURCHASE_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const SERVER_METADATA_TIMEOUT_MS = 250;

// Single in-flight syncSubscription. Concurrent callers (vpnState.connectVpn,
// HomeScreen useEffect, manual refresh) all await the same promise.
let syncInFlight: Promise<void> | null = null;
let syncInFlightGeneration: number | null = null;
let pendingPurchaseRefresh: Promise<void> | null = null;
let pendingPurchaseMemory: PendingPurchaseState | null = null;
let subscriptionUrlMemoryCache: { shortUuid: string; url: string } | null = null;
let subscriptionUsageBlockedMemory: { shortUuid: string; blocked: boolean } | null = null;
let updateRequiredMemory: boolean | null = null;
let pendingAuthTokenMemory: string | null = null;
let vpnServersMemoryCache: {
  shortUuid: string;
  servers: VpnServer[];
} | null = null;
let vpnServersCacheGeneration = 0;

interface PendingPurchaseState {
  startedAt: number;
  deviceId: string;
  telegramId: number;
  baselinePlan: UserPlan | null;
  baselineExpiresAt: number | null;
}

interface SessionWorkIdentity {
  generation: number;
  deviceId: string;
  telegramId: number | null;
}

function captureSessionWorkIdentity(): SessionWorkIdentity {
  const session = getSession();
  return {
    generation: getSessionGeneration(),
    deviceId: session.deviceId,
    telegramId: session.telegramId,
  };
}

function isSessionWorkIdentityCurrent(expected: SessionWorkIdentity): boolean {
  const session = getSession();
  return (
    getSessionGeneration() === expected.generation &&
    session.deviceId === expected.deviceId &&
    session.telegramId === expected.telegramId
  );
}

function sessionWorkSuperseded(): Error {
  return new Error("Device session changed while the operation was in flight");
}

function readSubInterval(): number {
  try {
    const raw = localStorage.getItem(SUB_INTERVAL_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) &&
      parsed >= MIN_SUB_INTERVAL_MS &&
      parsed <= MAX_SUB_INTERVAL_MS
      ? parsed
      : DEFAULT_SUB_INTERVAL_MS;
  } catch {
    return DEFAULT_SUB_INTERVAL_MS;
  }
}

function readSubLastSyncAt(): number {
  try {
    const raw = localStorage.getItem(SUB_SYNC_AT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeSubSyncState(intervalMs: number | null): void {
  try {
    const proposed = intervalMs ?? readSubInterval();
    const interval = Number.isFinite(proposed)
      ? Math.min(MAX_SUB_INTERVAL_MS, Math.max(MIN_SUB_INTERVAL_MS, proposed))
      : DEFAULT_SUB_INTERVAL_MS;
    localStorage.setItem(SUB_SYNC_AT_KEY, String(Date.now()));
    localStorage.setItem(SUB_INTERVAL_KEY, String(interval));
  } catch {
    // localStorage can fail in private-mode webviews; the next call falls
    // back to the default interval, which is the safest behaviour.
  }
}

function readCachedSubscriptionUrl(shortUuid: string): string | null {
  if (subscriptionUrlMemoryCache?.shortUuid === shortUuid) {
    return subscriptionUrlMemoryCache.url;
  }
  try {
    // Remove plaintext caches written by older releases. Full subscription
    // URLs contain reusable credentials and are memory-only now.
    localStorage.removeItem(LEGACY_SUB_URL_CACHE_KEY);
    const raw = localStorage.getItem(SUB_URL_CACHE_KEY);
    localStorage.removeItem(SUB_URL_CACHE_KEY);
    if (raw && !subscriptionUrlMemoryCache) {
      const cached = JSON.parse(raw) as { shortUuid?: unknown; url?: unknown };
      if (cached.shortUuid === shortUuid && typeof cached.url === "string" && cached.url) {
        subscriptionUrlMemoryCache = { shortUuid, url: cached.url };
      }
    }
    return subscriptionUrlMemoryCache?.shortUuid === shortUuid
      ? subscriptionUrlMemoryCache.url
      : null;
  } catch {
    return null;
  }
}

function writeCachedSubscriptionUrl(shortUuid: string, url: string | null): void {
  if (url) {
    subscriptionUrlMemoryCache = { shortUuid, url };
  } else if (subscriptionUrlMemoryCache?.shortUuid === shortUuid) {
    subscriptionUrlMemoryCache = null;
  }
  try {
    localStorage.removeItem(LEGACY_SUB_URL_CACHE_KEY);
    localStorage.removeItem(SUB_URL_CACHE_KEY);
  } catch {
    // ignore — see writeSubSyncState
  }
}

function setSubscriptionUsageBlocked(shortUuid: string, blocked: boolean): void {
  subscriptionUsageBlockedMemory = { shortUuid, blocked };
  if (blocked) {
    clearVpnServersMemoryCache(shortUuid);
  }
  try {
    if (blocked) {
      localStorage.setItem(BLOCKED_SUBSCRIPTION_KEY, shortUuid);
    } else if (localStorage.getItem(BLOCKED_SUBSCRIPTION_KEY) === shortUuid) {
      localStorage.removeItem(BLOCKED_SUBSCRIPTION_KEY);
    }
  } catch {
    // Keep connection handling functional in webviews without persistence.
  }
  window.dispatchEvent(new Event(SUBSCRIPTION_ACCESS_EVENT));
}

function isSubscriptionUsageBlocked(shortUuid: string | null): boolean {
  if (!shortUuid) return false;
  if (subscriptionUsageBlockedMemory?.shortUuid === shortUuid) {
    return subscriptionUsageBlockedMemory.blocked;
  }
  try {
    const blocked = localStorage.getItem(BLOCKED_SUBSCRIPTION_KEY) === shortUuid;
    subscriptionUsageBlockedMemory = { shortUuid, blocked };
    return blocked;
  } catch {
    return false;
  }
}

export function getSubscriptionUsageBlocked(): boolean {
  return isSubscriptionUsageBlocked(getSession().shortUuid);
}

export function getUpdateRequired(): boolean {
  if (updateRequiredMemory !== null) return updateRequiredMemory;
  try {
    updateRequiredMemory = localStorage.getItem(UPDATE_REQUIRED_KEY) === "yes";
    return updateRequiredMemory;
  } catch {
    return updateRequiredMemory ?? false;
  }
}

function setUpdateRequired(required: boolean): void {
  const was = getUpdateRequired();
  updateRequiredMemory = required;
  try {
    if (required) {
      localStorage.setItem(UPDATE_REQUIRED_KEY, "yes");
    } else {
      localStorage.removeItem(UPDATE_REQUIRED_KEY);
    }
  } catch {}
  if (was !== getUpdateRequired()) {
    window.dispatchEvent(new Event(SUBSCRIPTION_ACCESS_EVENT));
  }
}

export function subscribeSubscriptionUsageBlocked(listener: () => void): () => void {
  const onAccessChanged = () => listener();
  window.addEventListener(SUBSCRIPTION_ACCESS_EVENT, onAccessChanged);
  const unsubscribeSession = subscribeSession(() => listener());
  return () => {
    window.removeEventListener(SUBSCRIPTION_ACCESS_EVENT, onAccessChanged);
    unsubscribeSession();
  };
}

function clearSubSyncTimestamp(): void {
  try {
    localStorage.removeItem(SUB_SYNC_AT_KEY);
  } catch {
    // ignore — see writeSubSyncState
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readPendingPurchaseState(): PendingPurchaseState | null {
  const current = getSession();
  const belongsToCurrentSession = (state: PendingPurchaseState | null) =>
    Boolean(
      state &&
      current.isLinked &&
      current.telegramId !== null &&
      state.deviceId === current.deviceId &&
      state.telegramId === current.telegramId,
    );
  try {
    // v1 had no account identity and could refresh a purchase after a later
    // user linked this installation. Never consume it.
    localStorage.removeItem(LEGACY_PENDING_PURCHASE_KEY);
    const raw = localStorage.getItem(PENDING_PURCHASE_KEY);
    if (!raw) return belongsToCurrentSession(pendingPurchaseMemory)
      ? pendingPurchaseMemory
      : null;
    const parsed = JSON.parse(raw) as Partial<PendingPurchaseState>;
    const now = Date.now();
    if (
      !Number.isSafeInteger(parsed.startedAt) ||
      (parsed.startedAt ?? 0) < 946_684_800_000 ||
      (parsed.startedAt ?? 0) > now + PERSISTED_TIMESTAMP_FUTURE_TOLERANCE_MS ||
      typeof parsed.deviceId !== "string" ||
      parsed.deviceId.length === 0 ||
      parsed.deviceId.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(parsed.deviceId) ||
      !Number.isSafeInteger(parsed.telegramId) ||
      (parsed.telegramId ?? 0) <= 0
    ) {
      localStorage.removeItem(PENDING_PURCHASE_KEY);
      pendingPurchaseMemory = null;
      return null;
    }
    const state: PendingPurchaseState = {
      startedAt: parsed.startedAt as number,
      deviceId: parsed.deviceId,
      telegramId: parsed.telegramId as number,
      baselinePlan:
        parsed.baselinePlan === "PAID" ||
        parsed.baselinePlan === "ADMIN" ||
        parsed.baselinePlan === "FREE_TRIAL" ||
        parsed.baselinePlan === "EXPIRED"
          ? parsed.baselinePlan
          : null,
      baselineExpiresAt: epochTimestampToMillis(parsed.baselineExpiresAt),
    };
    if (!belongsToCurrentSession(state)) {
      localStorage.removeItem(PENDING_PURCHASE_KEY);
      pendingPurchaseMemory = null;
      return null;
    }
    pendingPurchaseMemory = state;
    return state;
  } catch {
    return belongsToCurrentSession(pendingPurchaseMemory)
      ? pendingPurchaseMemory
      : null;
  }
}

export function markPendingPurchaseStarted(input: {
  baselinePlan?: UserPlan | null;
  baselineExpiresAt?: number | null;
} = {}): void {
  const session = getSession();
  if (!session.isLinked || session.telegramId === null) return;
  const state: PendingPurchaseState = {
    startedAt: Date.now(),
    deviceId: session.deviceId,
    telegramId: session.telegramId,
    baselinePlan: input.baselinePlan ?? null,
    baselineExpiresAt: epochTimestampToMillis(input.baselineExpiresAt),
  };
  pendingPurchaseMemory = state;
  try {
    localStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify(state));
    localStorage.removeItem(LEGACY_PENDING_PURCHASE_KEY);
  } catch {
    // The memory value still starts the in-session refresh below.
  }
}

export function clearPendingPurchase(): void {
  pendingPurchaseMemory = null;
  try {
    localStorage.removeItem(PENDING_PURCHASE_KEY);
    localStorage.removeItem(LEGACY_PENDING_PURCHASE_KEY);
  } catch {
    // ignore
  }
}

export function getPendingAuthToken(): string | null {
  try {
    const legacy = localStorage.getItem(PENDING_AUTH_TOKEN_KEY);
    localStorage.removeItem(PENDING_AUTH_TOKEN_KEY);
    if (!pendingAuthTokenMemory) pendingAuthTokenMemory = normalizePendingAuthToken(legacy);
    return pendingAuthTokenMemory;
  } catch {
    return null;
  }
}

export function clearPendingAuthToken(): void {
  pendingAuthTokenMemory = null;
  try {
    localStorage.removeItem(PENDING_AUTH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

function writePendingAuthToken(token: string): void {
  pendingAuthTokenMemory = normalizePendingAuthToken(token);
  try {
    localStorage.removeItem(PENDING_AUTH_TOKEN_KEY);
  } catch {
    // memory value remains available for the current run
  }
}

function normalizePendingAuthToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  return trimmed &&
    trimmed.length <= MAX_PENDING_AUTH_TOKEN_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : null;
}

async function settleStartupStep<T>(
  label: string,
  task: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timeoutId: number | null = null;
  const guardedTask = task
    .then((result) => result as T | null)
    .catch((error) => {
      console.warn(`[startup] ${label} failed:`, error);
      return null;
    });
  const timeoutTask = new Promise<null>((resolve) => {
    timeoutId = window.setTimeout(() => {
      console.warn(`[startup] ${label} timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([guardedTask, timeoutTask]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

async function getDeviceName(): Promise<string> {
  if (cachedHostname) return cachedHostname;
  try {
    const fingerprint = await getDeviceFingerprint();
    const model = cleanDesktopModelName(fingerprint.model, fingerprint.platform);
    if (model) {
      cachedHostname = model;
      return cachedHostname;
    }
    const platform = fingerprint.platform.trim();
    if (platform && platform !== "Desktop") {
      cachedHostname = `${platform} PC`;
      return cachedHostname;
    }
  } catch {
    // Tauri commands unavailable (e.g. running in browser)
  }
  return "ToBeVPN Desktop";
}

function cleanDesktopModelName(model: string, platform: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "";
  const normalized = trimmed.toLocaleLowerCase("en-US");
  const normalizedPlatform = platform.trim().toLocaleLowerCase("en-US");
  const generic = new Set([
    "desktop",
    "pc",
    "linux",
    "windows",
    "macos",
    normalizedPlatform,
  ]);
  return generic.has(normalized) ? "" : trimmed;
}

function planForPanelUser(user: PanelUserDto): UserPlan {
  const squads = Array.isArray(user.active_internal_squads)
    ? user.active_internal_squads
        .map((s) => typeof s?.name === "string" ? s.name.toUpperCase() : "")
    : [];
  if (squads.includes("ADMINS")) return "ADMIN";
  if (squads.includes("STANDART")) return "PAID";
  return "FREE_TRIAL";
}

interface CurrentSubscriptionPlanInfo {
  displayName: string | null;
  trafficLimitBytes: number | null;
  deviceLimit: number | null;
  expiresAtMillis: number | null;
  isActive: boolean | null;
  isExpired: boolean | null;
  isTrial: boolean | null;
  isUnlimited: boolean | null;
  isAdmin: boolean;
  hasPlanData: boolean;
  subscriptionUrl: string | null;
  renewalUrl: string | null;
}

function normalizePlanTrafficLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  if (value <= 0) return 0;
  const bytes = value > 1024 * 1024 ? value : value * 1024 * 1024 * 1024;
  return Number.isFinite(bytes)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(bytes))
    : null;
}

function normalizeTrafficLimitBytes(
  trafficLimitBytes: number | null | undefined,
  trafficLimit: number | null | undefined,
): number | null {
  if (trafficLimitBytes !== null && trafficLimitBytes !== undefined) {
    return Number.isFinite(trafficLimitBytes) && trafficLimitBytes >= 0
      ? Math.min(Math.round(trafficLimitBytes), Number.MAX_SAFE_INTEGER)
      : null;
  }
  return normalizePlanTrafficLimit(trafficLimit);
}

function epochTimestampToMillis(value: number | null | undefined): number | null {
  const timestamp = Number.isFinite(value) && (value ?? 0) > 0 ? Number(value) : null;
  if (timestamp === null) return null;
  const millis = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return Number.isSafeInteger(millis) &&
    millis >= 946_684_800_000 &&
    millis <= 4_102_444_800_000
    ? millis
    : null;
}

function currentPlanInfoFromDto(dto: CurrentPlanDto | null | undefined): CurrentSubscriptionPlanInfo | null {
  if (!dto || typeof dto !== "object" || Array.isArray(dto)) return null;
  const snapshotCandidate = dto.current_plan ?? dto.plan_snapshot ?? null;
  const snapshot = snapshotCandidate && typeof snapshotCandidate === "object" && !Array.isArray(snapshotCandidate)
    ? snapshotCandidate
    : null;
  const subscriptionCandidate = dto.subscription ?? null;
  const subscription = subscriptionCandidate && typeof subscriptionCandidate === "object" && !Array.isArray(subscriptionCandidate)
    ? subscriptionCandidate
    : null;
  const safeText = (value: unknown, max = 512): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed)
      ? trimmed
      : null;
  };
  const subscriptionStatus =
    safeText(subscription?.status, 64) ??
    safeText(subscription?.stored_status, 64) ??
    safeText(dto.status, 64);
  const booleanOrNull = (value: unknown): boolean | null =>
    typeof value === "boolean" ? value : null;
  const expiresAtMillis =
    epochTimestampToMillis(subscription?.expire_at_ts) ??
    parseExpiresAtMillis(subscription?.expire_at) ??
    parseExpiresAtMillis(subscription?.expires_at) ??
    parseExpiresAtMillis(dto.expire_at) ??
    parseExpiresAtMillis(dto.expires_at);
  const isExpired =
    booleanOrNull(subscription?.is_expired) ??
    (subscriptionStatus ? subscriptionStatus.toUpperCase() === "EXPIRED" : null) ??
    (expiresAtMillis !== null ? expiresAtMillis <= Date.now() : null);
  const isActive =
    booleanOrNull(subscription?.is_active) ??
    (subscriptionStatus ? subscriptionStatus.toUpperCase() === "ACTIVE" : null);
  const snapshotName = safeText(snapshot?.name, 128);
  const dtoPlanName = safeText(dto.plan_name, 128);
  const dtoName = safeText(dto.name, 128);
  const hasPlanData = Boolean(snapshot || subscription || dtoPlanName || dtoName);
  const displayName =
    snapshotName ?? dtoPlanName ?? dtoName;
  return {
    displayName,
    trafficLimitBytes:
      normalizeTrafficLimitBytes(subscription?.traffic_limit_bytes, subscription?.traffic_limit) ??
      normalizeTrafficLimitBytes(snapshot?.traffic_limit_bytes, snapshot?.traffic_limit),
    deviceLimit:
      Number.isSafeInteger(subscription?.device_limit) && (subscription?.device_limit ?? -1) >= 0
        ? Math.min(subscription?.device_limit ?? 0, 10_000)
        : Number.isSafeInteger(snapshot?.device_limit) && (snapshot?.device_limit ?? -1) >= 0
          ? Math.min(snapshot?.device_limit ?? 0, 10_000)
          : null,
    expiresAtMillis,
    isActive,
    isExpired,
    isTrial:
      booleanOrNull(subscription?.is_trial) ?? booleanOrNull(snapshot?.is_trial),
    isUnlimited:
      typeof subscription?.is_unlimited === "boolean"
        ? subscription.is_unlimited
        : safeText(snapshot?.type, 64)?.toUpperCase() === "UNLIMITED" || null,
    isAdmin: dto.is_admin === true,
    hasPlanData,
    subscriptionUrl: safeText(subscription?.url, 2_048),
    renewalUrl: safeText(dto.renewal_url, 2_048),
  };
}

async function fetchCurrentSubscriptionPlan(): Promise<CurrentSubscriptionPlanInfo | null> {
  try {
    const res = await getCurrentPlan();
    if (!res.success) return null;
    return currentPlanInfoFromDto(res.data);
  } catch {
    return null;
  }
}

function parsePanelExpireAtMillis(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
}

function selectBestPanelUser(
  users: PanelUserDto[],
  preferredPanelUserUuid?: string | null,
  preferredShortUuid?: string | null,
): PanelUserDto | null {
  if (users.length === 0) return null;
  const byPanel = preferredPanelUserUuid
    ? users.find((u) => u.uuid === preferredPanelUserUuid)
    : null;
  if (byPanel) return byPanel;
  const byShort = preferredShortUuid
    ? users.find((u) => u.short_uuid === preferredShortUuid)
    : null;
  if (byShort) return byShort;

  const planRank = (u: PanelUserDto): number =>
    planForPanelUser(u) === "ADMIN" ? 3 : planForPanelUser(u) === "PAID" ? 2 : 1;

  return [...users].sort((a, b) => {
    const planDiff = planRank(b) - planRank(a);
    if (planDiff !== 0) return planDiff;
    const activeDiff =
      (b.status.toUpperCase() === "ACTIVE" ? 1 : 0) -
      (a.status.toUpperCase() === "ACTIVE" ? 1 : 0);
    if (activeDiff !== 0) return activeDiff;
    const monthDiff =
      (b.traffic_limit_strategy.toUpperCase() === "MONTH" ? 1 : 0) -
      (a.traffic_limit_strategy.toUpperCase() === "MONTH" ? 1 : 0);
    if (monthDiff !== 0) return monthDiff;
    return parsePanelExpireAtMillis(b.expire_at) - parsePanelExpireAtMillis(a.expire_at);
  })[0] ?? null;
}

function parseExpiresAtMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim() || value.length > 128) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts >= 946_684_800_000 && ts <= 4_102_444_800_000
    ? ts
    : null;
}

function resolvePlanFromCurrentPlan(cachedPlan: UserPlan, currentPlanInfo: CurrentSubscriptionPlanInfo | null): UserPlan {
  if (!currentPlanInfo) return cachedPlan;
  if (!currentPlanInfo.hasPlanData) return "FREE_TRIAL";
  if (currentPlanInfo.isExpired === true || currentPlanInfo.isActive === false) return "EXPIRED";
  if (currentPlanInfo.isTrial === true) return "FREE_TRIAL";
  return "PAID";
}

// --- Public API ---

export async function initializeAuthSession(): Promise<void> {
  const currentSession = getSession();
  const secureSession = await loadSecureSession();

  if (secureSession) {
    applySessionSecrets(secureSession);
  } else {
    const legacySecrets = getSessionSecrets(currentSession);
    if (legacySecrets) {
      await saveSecureSession(legacySecrets);
      applySessionSecrets(legacySecrets);
    }
  }

  await settleStartupStep(
    "ensureDeviceSession",
    ensureDeviceSession(),
    STARTUP_SESSION_TIMEOUT_MS,
  );

  const sessionAfterSync = getSession();
  if (sessionAfterSync.isLinked || sessionAfterSync.shortUuid) {
    await settleStartupStep(
      "syncSubscription",
      syncSubscription({ force: true }),
      STARTUP_SUBSCRIPTION_TIMEOUT_MS,
    );
    startPendingPurchaseRefreshIfNeeded();
  }
}

export async function registerCurrentDevice(): Promise<void> {
  const deviceName = await getDeviceName();
  const res = await registerDevice({
    device_name: deviceName,
    device_type: DEVICE_TYPE,
    platform: PLATFORM,
  });
  if (!res.success) throw new Error(res.message ?? "Could not register device");
}

export async function getCurrentDeviceAliases(): Promise<string[]> {
  const aliases = new Set<string>();
  const addAlias = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    aliases.add(trimmed);
    aliases.add(trimmed.toLocaleLowerCase("en-US"));
  };

  addAlias(getSession().deviceId);
  try {
    addAlias((await getDeviceFingerprint()).hwid);
  } catch {
    // Keep the app-session id if the platform fingerprint is temporarily unavailable.
  }

  return Array.from(aliases);
}

export async function unlinkCurrentDevice(): Promise<void> {
  const deviceId = getSession().deviceId.trim();
  if (!deviceId) throw new Error("Current device identity is missing");
  const res = await unlinkDevice({ device_id: deviceId });
  if (!res.success) throw new Error(res.message ?? "Could not unlink device");
}

export interface PairingCode {
  authToken: string;
  qrUrl: string;
}

export interface DevicePairingCode {
  code: string;
  expiresIn: number;
}

function requireBoundedToken(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) throw new Error(`Invalid ${label}`);
  return trimmed;
}

function isValidTelegramId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export async function createPairingCode(): Promise<PairingCode> {
  await ensureDeviceSession();
  const session = getSession();
  const res = await requestAuth({
    panel_user_uuid: session.panelUserUuid,
  });
  if (!res.success || !res.data) throw new Error(res.message ?? "Empty auth response");

  const authToken = requireBoundedToken(res.data.auth_token, "authentication token");
  writePendingAuthToken(authToken);
  const qrUrl = getPairingOpenTargets(authToken).browserUrl;
  return { authToken, qrUrl };
}

export async function createDevicePairingCode(): Promise<DevicePairingCode> {
  await ensureDeviceSession();
  const res = await createTvPairing({});
  if (!res.success || !res.data) throw new Error(res.message ?? "Empty pairing response");
  const code = requireBoundedToken(res.data.code, "pairing code", 128);
  if (!Number.isSafeInteger(res.data.expires_in) || res.data.expires_in <= 0 || res.data.expires_in > 604_800) {
    throw new Error("Invalid pairing expiration");
  }
  return {
    code,
    expiresIn: res.data.expires_in,
  };
}

export function getPairingOpenTargets(authToken: string): {
  desktopUrl: string;
  browserUrl: string;
} {
  const encodedToken = encodeURIComponent(
    requireBoundedToken(authToken, "authentication token"),
  );
  return {
    desktopUrl: `tg://resolve?domain=${TELEGRAM_BOT_NAME}&start=${encodedToken}`,
    browserUrl: `https://t.me/${TELEGRAM_BOT_NAME}?start=${encodedToken}`,
  };
}

export type PairingPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "completed"; payload: NonNullable<AuthStatusDto> };

export type DevicePairingPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "completed"; payload: NonNullable<TvPairStatusDto> };

export async function pollPairing(authToken: string): Promise<PairingPollResult> {
  const res = await checkAuthStatus(requireBoundedToken(authToken, "authentication token"));
  if (!res.success || !res.data) {
    const message = res.message ?? "Auth token not found";
    if (/not found|expired/i.test(message)) return { status: "expired" };
    throw new Error(message);
  }
  const data = res.data;
  if (data.status === "completed") {
    if (!isValidTelegramId(data.telegram_id)) {
      throw new Error("Pairing completed without a valid telegram_id");
    }
    return { status: "completed", payload: data };
  }
  if (data.status !== "pending") throw new Error("Unknown pairing status");
  return { status: "pending" };
}

export async function pollDevicePairing(code: string): Promise<DevicePairingPollResult> {
  const res = await checkTvPairingStatus(requireBoundedToken(code, "pairing code", 128));
  if (!res.success || !res.data) {
    const message = res.message ?? "Pairing code not found";
    if (/not found|expired/i.test(message)) return { status: "expired" };
    throw new Error(message);
  }
  const data = res.data;
  if (data.status === "completed") {
    if (!isValidTelegramId(data.telegram_id)) {
      throw new Error("Pairing completed without a valid telegram_id");
    }
    return { status: "completed", payload: data };
  }
  if (data.status === "expired") return { status: "expired" };
  if (data.status === "rejected") throw new Error(res.message ?? "Pairing was rejected");
  if (data.status !== "pending") throw new Error("Unknown pairing status");
  return { status: "pending" };
}

/**
 * Deep-link auth already binds the current device-session server-side.
 * We only need to seed local identity and refresh subscription metadata.
 */
export async function authenticateWithTelegramId(
  telegramId: number,
  preferredShortUuid?: string | null,
  preferredPanelUserUuid?: string | null,
): Promise<void> {
  if (!isValidTelegramId(telegramId)) {
    throw new Error("Invalid Telegram identity");
  }
  // Pairing establishes a new identity boundary. Invalidate requests started
  // by the anonymous or previous session before publishing the linked state.
  invalidateSessionWork();
  markLinkedIdentity({
    telegramId,
    shortUuid: preferredShortUuid,
    panelUserUuid: preferredPanelUserUuid,
  });

  const pairingGeneration = getSessionGeneration();
  try {
    await bootstrapDeviceSession();
  } catch (error) {
    const currentSession = getSession();
    if (
      getSessionGeneration() === pairingGeneration &&
      currentSession.isLinked &&
      currentSession.telegramId === telegramId
    ) {
      // A network/bootstrap failure must not leave a locally fabricated
      // linked identity behind. Keep the anonymous device-session tokens so
      // the same pairing result can be retried without reinstalling.
      clearIdentity();
    }
    throw error;
  }
  const afterBootstrap = getSession();
  if (
    !afterBootstrap.isLinked ||
    afterBootstrap.telegramId !== telegramId
  ) {
    throw new Error("Device pairing was superseded or rejected");
  }
  // Bootstrap may legitimately fill/rotate shortUuid and therefore advance
  // the identity generation. From this point onward that refreshed identity
  // is the one the subscription sync must retain.
  const generation = getSessionGeneration();

  // Force the sync — we just authenticated and the user expects to
  // immediately see the right plan (PAID / FREE_TRIAL), not whatever
  // was cached pre-login.
  await syncSubscription({ force: true });
  const completedSession = getSession();
  if (
    generation !== getSessionGeneration() ||
    !completedSession.isLinked ||
    completedSession.telegramId !== telegramId
  ) {
    throw new Error("Device pairing was superseded or rejected");
  }
}

/**
 * Refresh subscription info (plan, expiry, traffic) from the panel.
 * No-op for unpaired devices.
 *
 * @param force when true, bypass the panel-recommended refresh cadence
 *   (`profile-update-interval`, default 12h). Use this for explicit
 *   user-initiated refreshes (the Refresh button on the server list);
 *   leave it false for ambient triggers (HomeScreen mount, post-login
 *   recovery) so we don't hit the panel on every re-mount.
 */
export async function syncSubscription(opts: { force?: boolean } = {}): Promise<void> {
  const { force = false } = opts;
  const generation = getSessionGeneration();
  if (syncInFlight && syncInFlightGeneration === generation) return syncInFlight;
  if (!force) {
    const last = readSubLastSyncAt();
    const age = Date.now() - last;
    if (last > 0 && age >= 0 && age < readSubInterval()) return;
  }
  const promise = runSyncSubscription(generation).finally(() => {
    if (syncInFlight === promise) {
      syncInFlight = null;
      syncInFlightGeneration = null;
    }
  });
  syncInFlight = promise;
  syncInFlightGeneration = generation;
  return promise;
}

export function startPendingPurchaseRefreshIfNeeded(): void {
  if (pendingPurchaseRefresh) return;
  const pending = readPendingPurchaseState();
  if (!pending) return;

  pendingPurchaseRefresh = runPendingPurchaseRefresh(
    pending,
    getSessionGeneration(),
  ).finally(() => {
    pendingPurchaseRefresh = null;
  });
}

/**
 * Bare HWID-marker ping used by the connect path so the subscription service
 * sees the device on every VPN start. A cached full URL is preferred; the
 * pinger can reconstruct the direct URL from the subscription key.
 */
export async function pingHwidOnly(): Promise<boolean> {
  const session = getSession();
  const shortUuid = session.shortUuid;
  const expectedGeneration = getSessionGeneration();
  const expectedDeviceId = session.deviceId;
  const isCurrent = () => {
    const currentSession = getSession();
    return (
      getSessionGeneration() === expectedGeneration &&
      currentSession.deviceId === expectedDeviceId &&
      currentSession.shortUuid === shortUuid
    );
  };
  const wasBlocked = isSubscriptionUsageBlocked(shortUuid);
  if (!shortUuid) return wasBlocked;
  const url = await readSubscriptionUrl(shortUuid, isCurrent);
  // Fail closed for callers that are still trying to start a tunnel under a
  // superseded identity. The new session can issue its own access check.
  if (!isCurrent()) return true;
  try {
    const result = await pingSubscriptionUrl(url, shortUuid);
    if (!isCurrent()) return true;
    if (!result) return wasBlocked;
    setSubscriptionUsageBlocked(shortUuid, result.isUsageBlocked);
    setUpdateRequired(result.isUpdateRequired);
    return result.isUsageBlocked;
  } catch {
    return wasBlocked;
  }
}

async function readSubscriptionUrl(
  shortUuid: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  const cached = readCachedSubscriptionUrl(shortUuid);
  if (cached) return cached;
  if (isCurrent() && getSession().isLinked) {
    const currentPlanInfo = await fetchCurrentSubscriptionPlan();
    if (!isCurrent()) return null;
    if (currentPlanInfo?.subscriptionUrl) {
      writeCachedSubscriptionUrl(shortUuid, currentPlanInfo.subscriptionUrl);
      return currentPlanInfo.subscriptionUrl;
    }
  }
  return null;
}

async function runSyncSubscription(expectedGeneration: number): Promise<void> {
  let session = getSession();
  const expectedDeviceId = session.deviceId;
  const isCurrent = () =>
    getSessionGeneration() === expectedGeneration &&
    getSession().deviceId === expectedDeviceId;

  const telegramId = session.telegramId;

  let panelUser: PanelUserDto | null = null;
  let currentPlanInfo: CurrentSubscriptionPlanInfo | null = null;
  if (session.isLinked && telegramId !== null) {
    try {
    const { response: panelUsers } = await getUserByTelegramId(telegramId);
    if (!isCurrent()) return;
    panelUser = selectBestPanelUser(
      panelUsers,
      session.panelUserUuid,
      session.shortUuid,
    );
    if (panelUser) {
      session = updateSession({
        shortUuid: panelUser.short_uuid,
        panelUserUuid: panelUser.uuid,
        email: panelUser.email ?? session.email,
      });
    }
    } catch {
      // Fall through — keep using the cached shortUuid.
    }
    currentPlanInfo = await fetchCurrentSubscriptionPlan();
    if (!isCurrent()) return;
  }

  const shortUuid = session.shortUuid;
  if (!shortUuid) return;

  const subscriptionUrl: string | null =
    currentPlanInfo?.subscriptionUrl ??
    panelUser?.subscription_url ??
    readCachedSubscriptionUrl(shortUuid);
  if (subscriptionUrl) writeCachedSubscriptionUrl(shortUuid, subscriptionUrl);

  let profileResult: SubscriptionProfileResult | null = null;
  try {
    profileResult = await fetchSubscriptionProfile(subscriptionUrl, shortUuid);
    if (!isCurrent()) return;
  } catch {
    profileResult = null;
  }

  if (profileResult) {
    if (!isCurrent()) return;
    setSubscriptionUsageBlocked(shortUuid, profileResult.isUsageBlocked);
    setUpdateRequired(profileResult.isUpdateRequired);
    writeSubSyncState(profileResult.intervalMs);
  } else {
    clearSubSyncTimestamp();
  }

  if (profileResult?.isUsageBlocked) {
    clearVpnServersMemoryCache(shortUuid);
  } else if (profileResult?.links.length) {
    cacheVpnServersFromLinks(shortUuid, profileResult.links);
  } else if (profileResult?.isSuccessful) {
    clearVpnServersMemoryCache(shortUuid);
  }

  if (currentPlanInfo) {
    if (!isCurrent()) return;
    updateSession({
      userPlan: resolvePlanFromCurrentPlan(session.userPlan, currentPlanInfo),
      planDisplayName:
        currentPlanInfo.displayName ??
        (session.userPlan !== "EXPIRED" ? session.planDisplayName : null),
      planExpiresAt: currentPlanInfo.expiresAtMillis,
      trafficLimitBytes:
        profileResult?.trafficLimitBytes ??
        currentPlanInfo.trafficLimitBytes ??
        session.trafficLimitBytes,
      trafficUsedBytes: profileResult?.trafficUsedBytes ?? session.trafficUsedBytes,
      isAdminProfile: currentPlanInfo.isAdmin,
    });
    try {
      await registerCurrentDevice();
    } catch {
      // ignore
    }
    return;
  }

  if (panelUser) {
    if (!isCurrent()) return;
    const panelPlan = planForPanelUser(panelUser);
    const isActive = panelUser.status.toUpperCase() === "ACTIVE";
    const plan: UserPlan = !isActive
      ? "EXPIRED"
      : panelPlan !== "FREE_TRIAL"
        ? panelPlan
        : panelUser.traffic_limit_strategy.toUpperCase() === "MONTH"
          ? "PAID"
          : session.userPlan === "PAID" || session.userPlan === "ADMIN"
            ? session.userPlan
            : "FREE_TRIAL";
    updateSession({
      userPlan: plan,
      planDisplayName:
        session.userPlan === plan && plan !== "EXPIRED" ? session.planDisplayName : null,
      planExpiresAt: parseExpiresAtMillis(panelUser.expire_at),
      trafficLimitBytes:
        profileResult?.trafficLimitBytes ?? panelUser.traffic_limit_bytes,
      trafficUsedBytes:
        profileResult?.trafficUsedBytes ??
        panelUser.user_traffic?.used_traffic_bytes ??
        session.trafficUsedBytes,
    });
  } else if (profileResult) {
    if (!isCurrent()) return;
    updateSession({
      trafficLimitBytes:
        profileResult.trafficLimitBytes ?? session.trafficLimitBytes,
      trafficUsedBytes:
        profileResult.trafficUsedBytes ?? session.trafficUsedBytes,
    });
  }

  // Refresh "last seen" on the device row so it surfaces in linked-devices listings.
  if (session.isLinked) {
    try {
      await registerCurrentDevice();
    } catch {
      // ignore
    }
  }
}

async function runPendingPurchaseRefresh(
  initial: PendingPurchaseState,
  expectedGeneration: number,
): Promise<void> {
  const isCurrent = () => getSessionGeneration() === expectedGeneration;
  const wallAge = Math.max(0, Date.now() - initial.startedAt);
  const remainingLifetime = PURCHASE_PENDING_MAX_AGE_MS - wallAge;
  if (remainingLifetime <= 0) {
    expirePendingPurchase();
    return;
  }

  // Poll durations are process-local and must not stretch indefinitely when
  // NTP or the user moves the system clock backwards.
  const startedAt = performance.now();
  const activeDuration = Math.min(PURCHASE_REFRESH_ACTIVE_WINDOW_MS, remainingLifetime);
  while (performance.now() - startedAt <= activeDuration) {
    if (!isCurrent()) return;
    await refreshSubscriptionAfterPurchase();
    if (!isCurrent()) return;
    if (paymentLooksApplied(initial, getSession())) {
      clearPendingPurchase();
      return;
    }
    await sleepMs(PURCHASE_REFRESH_INTERVAL_MS);
  }

  const totalDuration = Math.min(PURCHASE_REFRESH_TOTAL_WINDOW_MS, remainingLifetime);
  while (performance.now() - startedAt <= totalDuration) {
    await sleepMs(PURCHASE_REFRESH_SLOW_INTERVAL_MS);
    if (!isCurrent()) return;
    await refreshSubscriptionAfterPurchase();
    if (!isCurrent()) return;
    if (paymentLooksApplied(initial, getSession())) {
      clearPendingPurchase();
      return;
    }
  }

  if (
    performance.now() - startedAt >= remainingLifetime ||
    Date.now() - initial.startedAt >= PURCHASE_PENDING_MAX_AGE_MS
  ) {
    expirePendingPurchase();
  }
}

function expirePendingPurchase(): void {
  clearPendingPurchase();
  clearSubSyncTimestamp();
}

async function refreshSubscriptionAfterPurchase(): Promise<void> {
  if (!getSession().isLinked) {
    clearPendingPurchase();
    return;
  }
  await syncSubscription({ force: true });
  await fetchVpnServers().catch(() => []);
}

function paymentLooksApplied(pending: PendingPurchaseState, session: Session): boolean {
  if (!session.isLinked) return false;
  const currentIsPaid = session.userPlan === "PAID" || session.userPlan === "ADMIN";
  const baselineWasPaid =
    pending.baselinePlan === "PAID" || pending.baselinePlan === "ADMIN";

  if (!baselineWasPaid && currentIsPaid) return true;

  return (
    baselineWasPaid &&
    currentIsPaid &&
    pending.baselineExpiresAt !== null &&
    session.planExpiresAt !== null &&
    session.planExpiresAt > pending.baselineExpiresAt
  );
}

type DeviceLinkStatus = "linked" | "missing" | "unknown";

function isRemoteDeviceUnlinkedError(error: unknown): boolean {
  if (!(error instanceof ApiHttpError)) return false;
  if (error.status === 401) return true;
  const message = error.message.trim().toLocaleLowerCase("en-US");
  if (!message) return false;
  if (error.status === 400) {
    return (
      message.includes("telegram_id is required") ||
      message.includes("current device session is not linked")
    );
  }
  if (error.status === 403) {
    return (
      message.includes("telegram_id not authenticated") ||
      message.includes("current device session is not linked")
    );
  }
  return false;
}

/**
 * Check whether the current device session is still linked server-side.
 * This must stay read-only: subscription/HWID pings can create or refresh
 * panel device rows, so they are intentionally not part of the remote-kick
 * decision.
 */
async function checkCurrentDeviceLinkStatus(): Promise<DeviceLinkStatus> {
  const { isLinked } = getSession();
  if (!isLinked) return "missing";
  const expectedGeneration = getSessionGeneration();
  try {
    const res = await getCurrentPlan();
    if (getSessionGeneration() !== expectedGeneration) return "unknown";
    if (res.success) {
      await applyCurrentPlanHeartbeat(res.data).catch(() => {});
    }
    return res.success ? "linked" : "unknown";
  } catch (error) {
    return isRemoteDeviceUnlinkedError(error) ? "missing" : "unknown";
  }
}

async function applyCurrentPlanHeartbeat(
  data: CurrentPlanDto | null | undefined,
): Promise<void> {
  const planInfo = currentPlanInfoFromDto(data);
  if (!planInfo) return;

  let expectedGeneration = getSessionGeneration();
  const sessionBefore = getSession();
  const expectedDeviceId = sessionBefore.deviceId;
  const expectedTelegramId = sessionBefore.telegramId;
  const oldShortUuid = sessionBefore.shortUuid;
  const cachedUrl = oldShortUuid ? readCachedSubscriptionUrl(oldShortUuid) : null;
  const nextUrl = planInfo.subscriptionUrl;
  const subscriptionUrlChanged = Boolean(nextUrl && nextUrl !== cachedUrl);
  let reconnectServer = subscriptionUrlChanged ? getActiveVpnReconnectServer() : null;
  let reconnectGeneration: number | null = null;

  if (subscriptionUrlChanged) {
    if (reconnectServer) {
      try {
        await disconnectVpn();
        reconnectGeneration = getVpnConnectionGeneration();
      } catch {
        // Never start a second tunnel when native cleanup is incomplete.
        reconnectServer = null;
      }
      if (getSessionGeneration() !== expectedGeneration) return;
    }
    await bootstrapDeviceSession().catch(() => {});
    const sessionAfterBootstrap = getSession();
    if (
      sessionAfterBootstrap.deviceId !== expectedDeviceId ||
      !sessionAfterBootstrap.isLinked ||
      sessionAfterBootstrap.telegramId !== expectedTelegramId
    ) return;
    // A legitimate bootstrap can rotate shortUuid/panelUserUuid and advance
    // the generation. Continue under that refreshed identity only.
    expectedGeneration = getSessionGeneration();
  }
  const refreshedSession = getSession();
  updateSession({
    userPlan: resolvePlanFromCurrentPlan(refreshedSession.userPlan, planInfo),
    planDisplayName:
      planInfo.isExpired === true
        ? null
        : (planInfo.displayName ?? refreshedSession.planDisplayName),
    planExpiresAt: planInfo.expiresAtMillis,
    trafficLimitBytes: planInfo.trafficLimitBytes ?? refreshedSession.trafficLimitBytes,
    isAdminProfile: planInfo.isAdmin,
  });

  if (!subscriptionUrlChanged) return;
  const nextShortUuid = getSession().shortUuid ?? oldShortUuid;
  if (oldShortUuid && oldShortUuid !== nextShortUuid) {
    writeCachedSubscriptionUrl(oldShortUuid, null);
    clearVpnServersMemoryCache(oldShortUuid);
  }
  if (nextShortUuid) {
    writeCachedSubscriptionUrl(nextShortUuid, nextUrl);
    clearVpnServersMemoryCache(nextShortUuid);
  }
  clearSubSyncTimestamp();
  await syncSubscription({ force: true }).catch(() => {});
  if (getSessionGeneration() !== expectedGeneration) return;
  await fetchVpnServers({ skipAccessPing: true }).catch(() => []);
  if (getSessionGeneration() !== expectedGeneration) return;
  if (
    reconnectServer &&
    reconnectGeneration !== null &&
    getSession().userPlan !== "EXPIRED"
  ) {
    await reconnectVpnWithFreshSubscription(reconnectServer, reconnectGeneration);
  }
}

export async function isCurrentDeviceLinked(): Promise<boolean> {
  return (await checkCurrentDeviceLinkStatus()) !== "missing";
}

const DEVICE_LINK_POLL_MS = 5 * 60_000;
const DEVICE_LINK_CLEANUP_RETRY_MS = 15_000;
let linkPollTimer: number | null = null;
let linkPollGeneration = 0;

/**
 * Start polling to detect remote device removal.
 * When the device is no longer linked, clears the local device session.
 * Navigation is handled reactively by App.tsx observing useSession().
 */
export function startDeviceLinkPolling() {
  stopDeviceLinkPolling();
  const generation = ++linkPollGeneration;

  const tick = async () => {
    if (generation !== linkPollGeneration) return;
    const session = getSession();
    if (!session.isLinked) {
      stopDeviceLinkPolling();
      return;
    }
    const status = await checkCurrentDeviceLinkStatus();
    if (generation !== linkPollGeneration) return;
    if (status === "linked") {
      linkPollTimer = window.setTimeout(tick, DEVICE_LINK_POLL_MS);
      return;
    }
    if (status === "unknown") {
      linkPollTimer = window.setTimeout(tick, DEVICE_LINK_POLL_MS);
      return;
    }

    // Tear down the tunnel before clearing identity — otherwise the OS-level
    // VPN keeps routing traffic after the user is bounced to the QR screen.
    invalidateSessionWork();
    const cleanupIdentity = captureSessionWorkIdentity();
    try {
      await disconnectVpn();
    } catch {
      // Keep the credentials/UI long enough to retry cleanup. Clearing them
      // now would strand an OS-level tunnel on a pairing screen with no Stop
      // control. Server-side revocation already prevents new access.
      if (generation === linkPollGeneration) {
        linkPollTimer = window.setTimeout(tick, DEVICE_LINK_CLEANUP_RETRY_MS);
      }
      return;
    }
    if (
      generation !== linkPollGeneration ||
      !isSessionWorkIdentityCurrent(cleanupIdentity)
    ) return;
    clearVpnServersMemoryCache(session.shortUuid);
    if (session.shortUuid) {
      writeCachedSubscriptionUrl(session.shortUuid, null);
    }
    clearSubSyncTimestamp();
    clearPendingPurchase();
    await clearSecureSession();
    if (
      generation !== linkPollGeneration ||
      !isSessionWorkIdentityCurrent(cleanupIdentity)
    ) return;
    clearDeviceSession();
    stopDeviceLinkPolling();
  };

  void tick();
}

export function stopDeviceLinkPolling() {
  linkPollGeneration += 1;
  if (linkPollTimer !== null) {
    clearTimeout(linkPollTimer);
    linkPollTimer = null;
  }
}

export async function logout(): Promise<void> {
  const { isLinked, shortUuid } = getSession();
  // Invalidate every request started by the old identity before waiting on
  // VPN/network cleanup. Late responses can no longer repopulate the session.
  invalidateSessionWork();
  const logoutIdentity = captureSessionWorkIdentity();
  // Always tear down the tunnel first — clearing identity alone would leave
  // a live VPN session orphaned in the background.
  // Do not erase the only credentials that can still issue a cleanup while
  // native state is ambiguous. The caller can surface the failure and retry.
  await disconnectVpn();
  if (!isSessionWorkIdentityCurrent(logoutIdentity)) throw sessionWorkSuperseded();
  if (isLinked) {
    try {
      await unlinkCurrentDevice();
    } catch {
      // ignore — clear local state regardless
    }
    if (!isSessionWorkIdentityCurrent(logoutIdentity)) throw sessionWorkSuperseded();
  }
  try {
    await logoutDevice();
  } catch {
    // ignore — local session is cleared regardless
  }
  if (!isSessionWorkIdentityCurrent(logoutIdentity)) throw sessionWorkSuperseded();
  await clearSecureSession();
  if (!isSessionWorkIdentityCurrent(logoutIdentity)) throw sessionWorkSuperseded();
  clearPendingPurchase();
  clearPendingAuthToken();
  clearVpnServersMemoryCache(shortUuid);
  if (shortUuid) writeCachedSubscriptionUrl(shortUuid, null);
  clearSubSyncTimestamp();
  clearDeviceSession();
}

// --- Pass-through helpers used by screens ---

export async function fetchNodes(): Promise<PanelNodeDto[]> {
  return sanitizePanelNodes((await apiGetNodes()).response);
}

function sanitizePanelNodes(value: unknown): PanelNodeDto[] {
  if (!Array.isArray(value)) return [];
  const nodes = new Map<string, PanelNodeDto>();
  const text = (input: unknown, max: number): string | null => {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed)
      ? trimmed
      : null;
  };
  for (const raw of value.slice(0, 512)) {
    if (raw === null || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    const uuid = text(node.uuid, 128);
    const rawAddress = text(node.address, 253);
    const address = rawAddress?.toLocaleLowerCase("en-US") ?? null;
    const port = Number(node.port);
    const country = text(node.country_code, 2);
    const viewPosition = Number(node.view_position);
    if (
      !uuid ||
      !address ||
      !isSafeVpnEndpoint(address) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      typeof node.is_connected !== "boolean" ||
      typeof node.is_disabled !== "boolean" ||
      !Number.isSafeInteger(viewPosition) ||
      viewPosition < -100_000 ||
      viewPosition > 100_000
    ) continue;
    nodes.set(uuid, {
      uuid,
      name: text(node.name, 128) ?? address,
      address,
      port,
      is_connected: node.is_connected,
      is_disabled: node.is_disabled,
      country_code: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "",
      view_position: viewPosition,
    });
  }
  return [...nodes.values()];
}

export async function fetchDevices(): Promise<LinkedDevicesDto | null> {
  const { isLinked } = getSession();
  if (!isLinked) return null;
  await pingHwidOnly().catch(() => false);
  const res = await apiGetDevices();
  if (!res.success || !res.data) {
    throw new Error(res.message ?? "Could not load linked devices");
  }
  return sanitizeLinkedDevices(res.data);
}

function sanitizeLinkedDevices(value: unknown): LinkedDevicesDto {
  const source = value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (!Array.isArray(source.devices)) throw new Error("Invalid linked devices response");
  const boundedString = (input: unknown, max = 256): string | null => {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed)
      ? trimmed
      : null;
  };
  const boundedEpoch = (input: unknown): number | null =>
    Number.isSafeInteger(input) && Number(input) > 0 && Number(input) <= 4_102_444_800
      ? Number(input)
      : null;
  const devices = new Map<string, LinkedDevicesDto["devices"][number]>();
  for (const raw of source.devices.slice(0, 128)) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const deviceId = boundedString(item.device_id, 128);
    if (!deviceId || devices.has(deviceId)) continue;
    devices.set(deviceId, {
      device_id: deviceId,
      hwid: boundedString(item.hwid, 256),
      device_name: boundedString(item.device_name),
      device_type: boundedString(item.device_type, 64),
      platform: boundedString(item.platform, 64),
      device_model: boundedString(item.device_model),
      user_agent: boundedString(item.user_agent, 512),
      linked_at: boundedEpoch(item.linked_at),
      last_seen_at: boundedEpoch(item.last_seen_at),
    });
  }
  const maxDevices = Number.isSafeInteger(source.max_devices) && Number(source.max_devices) >= 0
    ? Math.min(Number(source.max_devices), 10_000)
    : 0;
  const currentCount = Number.isSafeInteger(source.current_count) && Number(source.current_count) >= 0
    ? Math.min(Number(source.current_count), 10_000)
    : devices.size;
  return {
    devices: [...devices.values()],
    max_devices: maxDevices,
    current_count: currentCount,
  };
}

export async function unlinkOtherDevice(deviceId: string): Promise<void> {
  const { isLinked } = getSession();
  if (!isLinked) throw new Error("Not authenticated");
  const operationIdentity = captureSessionWorkIdentity();
  const normalizedDeviceId = requireBoundedToken(deviceId, "device identity", 128);
  const aliases = (await getCurrentDeviceAliases())
    .map((value) => value.toLocaleLowerCase("en-US"));
  if (!isSessionWorkIdentityCurrent(operationIdentity)) throw sessionWorkSuperseded();
  if (aliases.includes(normalizedDeviceId.toLocaleLowerCase("en-US"))) {
    throw new Error("The current device cannot be unlinked from this screen");
  }
  const reconnectServer = getActiveVpnReconnectServer();
  let reconnectGeneration: number | null = null;
  const res = await unlinkDevice({ device_id: normalizedDeviceId });
  if (!res.success) throw new Error(res.message ?? "Could not unlink device");
  if (!isSessionWorkIdentityCurrent(operationIdentity)) throw sessionWorkSuperseded();
  if (reconnectServer) {
    try {
      await disconnectVpn();
      reconnectGeneration = getVpnConnectionGeneration();
    } catch {
      // The device unlink may still complete, but an incomplete native stop
      // must never be followed by an automatic second start.
    }
    if (!isSessionWorkIdentityCurrent(operationIdentity)) throw sessionWorkSuperseded();
  }
  if (!(await refreshAfterDeviceUnlink(res.data, operationIdentity))) {
    throw sessionWorkSuperseded();
  }
  if (
    reconnectServer &&
    reconnectGeneration !== null &&
    isSessionWorkIdentityCurrent(operationIdentity) &&
    getSession().userPlan !== "EXPIRED"
  ) {
    await reconnectVpnWithFreshSubscription(reconnectServer, reconnectGeneration);
  }
}

async function refreshAfterDeviceUnlink(
  data: DeviceUnlinkResponseDto | null | undefined,
  operationIdentity: SessionWorkIdentity,
): Promise<boolean> {
  const sessionBefore = getSession();
  const oldShortUuid = sessionBefore.shortUuid;
  let bootstrapSucceeded = false;
  try {
    await bootstrapDeviceSession();
    bootstrapSucceeded = true;
  } catch {
    if (!isSessionWorkIdentityCurrent(operationIdentity)) return false;
  }

  const refreshedSession = getSession();
  if (
    refreshedSession.deviceId !== operationIdentity.deviceId ||
    refreshedSession.telegramId !== operationIdentity.telegramId
  ) return false;
  if (bootstrapSucceeded) {
    // Bootstrap may legitimately rotate panel identifiers. Adopt only the
    // generation produced by that successful, identity-preserving refresh.
    operationIdentity.generation = getSessionGeneration();
  }
  if (!isSessionWorkIdentityCurrent(operationIdentity)) return false;
  const nextShortUuid = refreshedSession.shortUuid ?? oldShortUuid;
  const planInfo = currentPlanInfoFromDto(data);
  const rawDirectUrl = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).subscription_url
    : null;
  const directUrl = typeof rawDirectUrl === "string" &&
    rawDirectUrl.trim().length > 0 &&
    rawDirectUrl.trim().length <= 2_048 &&
    !/[\u0000-\u001f\u007f]/.test(rawDirectUrl)
      ? rawDirectUrl.trim()
      : null;
  const nextUrl = directUrl ?? planInfo?.subscriptionUrl ?? null;
  if (oldShortUuid && nextShortUuid !== oldShortUuid) {
    writeCachedSubscriptionUrl(oldShortUuid, null);
    clearVpnServersMemoryCache(oldShortUuid);
  }
  if (nextShortUuid) {
    writeCachedSubscriptionUrl(nextShortUuid, nextUrl);
    clearVpnServersMemoryCache(nextShortUuid);
  }
  clearSubSyncTimestamp();

  if (planInfo) {
    updateSession({
      userPlan: resolvePlanFromCurrentPlan(refreshedSession.userPlan, planInfo),
      planDisplayName: planInfo.displayName ?? refreshedSession.planDisplayName,
      planExpiresAt: planInfo.expiresAtMillis,
      trafficLimitBytes: planInfo.trafficLimitBytes ?? refreshedSession.trafficLimitBytes,
      isAdminProfile: planInfo.isAdmin,
    });
  }

  await syncSubscription({ force: true }).catch(() => {});
  if (!isSessionWorkIdentityCurrent(operationIdentity)) return false;
  await fetchVpnServers({ skipAccessPing: true }).catch(() => []);
  return isSessionWorkIdentityCurrent(operationIdentity);
}

export async function saveEmail(email: string): Promise<void> {
  const { isLinked, panelUserUuid } = getSession();
  if (!isLinked) throw new Error("Not authenticated");
  const normalizedEmail = email.trim();
  if (
    !normalizedEmail ||
    normalizedEmail.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(normalizedEmail) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) throw new Error("Invalid email address");
  const res = await apiSaveEmail({ panel_user_uuid: panelUserUuid, email: normalizedEmail });
  if (!res.success) throw new Error(res.message ?? "Could not save email");
  updateSession({ email: normalizedEmail });
}

export async function fetchPurchasePlans(): Promise<PurchasePlansDto | null> {
  const { isLinked } = getSession();
  if (!isLinked) return null;
  if (await pingHwidOnly().catch(() => getSubscriptionUsageBlocked())) return null;
  const res = await apiGetPurchasePlans();
  if (!res.success || !res.data) return null;
  return sanitizePurchasePlansData(res.data, getSession().telegramId);
}

export function sanitizePurchasePlansData(
  value: unknown,
  expectedTelegramId: number | null = null,
): PurchasePlansDto | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const telegramId = Number(source.telegram_id);
  if (
    !Number.isSafeInteger(telegramId) ||
    telegramId <= 0 ||
    (expectedTelegramId !== null && telegramId !== expectedTelegramId) ||
    !Array.isArray(source.plans)
  ) return null;
  const text = (input: unknown, max: number, required = false): string | null => {
    if (typeof input !== "string") return required ? null : "";
    const trimmed = input.trim();
    if ((required && !trimmed) || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return null;
    }
    return trimmed;
  };
  const integer = (input: unknown, min: number, max: number): number | null => {
    const number = Number(input);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
  };
  const httpsUrl = (input: unknown): string | null => {
    const raw = text(input, 2_048);
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const plans: PurchasePlansDto["plans"] = [];
  for (const rawPlan of source.plans.slice(0, 50)) {
    if (rawPlan === null || typeof rawPlan !== "object") continue;
    const plan = rawPlan as Record<string, unknown>;
    const id = integer(plan.id, 1, Number.MAX_SAFE_INTEGER);
    const name = text(plan.name, 128, true);
    if (!id || !name || !Array.isArray(plan.durations)) continue;
    const durations: PurchasePlansDto["plans"][number]["durations"] = [];
    for (const rawDuration of plan.durations.slice(0, 32)) {
      if (rawDuration === null || typeof rawDuration !== "object") continue;
      const duration = rawDuration as Record<string, unknown>;
      const durationId = integer(duration.id, 1, Number.MAX_SAFE_INTEGER);
      const days = integer(duration.days, 1, 3_650);
      if (!durationId || !days) continue;
      const prices: PurchasePlansDto["plans"][number]["durations"][number]["prices"] = [];
      if (Array.isArray(duration.prices)) {
        for (const rawPrice of duration.prices.slice(0, 16)) {
          if (rawPrice === null || typeof rawPrice !== "object") continue;
          const price = rawPrice as Record<string, unknown>;
          const currency = text(price.currency, 16, true);
          const amount = text(price.amount, 64, true);
          if (!currency || !amount || !/^\d{1,12}(?:\.\d{1,6})?$/.test(amount)) continue;
          prices.push({ currency, amount });
        }
      }
      durations.push({
        id: durationId,
        days,
        order_index: integer(duration.order_index, -100_000, 100_000) ?? 0,
        bot_start_param: text(duration.bot_start_param, 256) || null,
        bot_payment_url: httpsUrl(duration.bot_payment_url),
        prices,
        payment_methods: [],
      });
    }
    if (durations.length === 0) continue;
    plans.push({
      id,
      public_code: text(plan.public_code, 128) || String(id),
      name,
      description: text(plan.description, 1_024) || null,
      type: text(plan.type, 64) || "PAID",
      availability: text(plan.availability, 64) || "PUBLIC",
      purchase_type: text(plan.purchase_type, 64) || "NEW",
      traffic_limit: integer(plan.traffic_limit, 0, 1_000_000) ?? 0,
      traffic_limit_strategy: text(plan.traffic_limit_strategy, 64) || null,
      device_limit: integer(plan.device_limit, 0, 10_000) ?? 0,
      tag: text(plan.tag, 128) || null,
      order_index: integer(plan.order_index, -100_000, 100_000) ?? 0,
      internal_squad_uuids: [],
      external_squad_uuid: null,
      durations,
    });
  }
  const discount = Number(source.effective_discount_percent);
  return {
    telegram_id: telegramId,
    effective_discount_percent: Number.isFinite(discount)
      ? Math.min(100, Math.max(0, discount))
      : 0,
    plans,
  };
}

// --- VLESS URL parsing (mirrors TV's VlessUrlParser.kt) ---

export interface VpnServer {
  id: string;
  name: string;
  address: string;
  port: number;
  uuid: string;
  flow: string;
  security: string;
  sni: string;
  fingerprint: string;
  public_key: string;
  short_id: string;
  network: string;
  path: string;
  mode: string;
  spx: string;
  country: string;
  isOnline: boolean;
  sortOrder: number;
}

export function seedVpnServersForBrowserPreview(
  shortUuid: string,
  servers: VpnServer[],
): void {
  if (!isBrowserPreviewRuntime()) return;
  writeVpnServersMemoryCache(shortUuid, servers);
}

interface ServerNameParts {
  base: string;
  number: number | null;
}

/**
 * True for the panel's "subscription expired" placeholder server. The
 * parser accepts it because it's a syntactically-valid VLESS URL, but
 * its uuid is the all-zeros UUID and the address points nowhere —
 * passing it to xray would crash the tunnel manager.
 */
export function isSentinelServer(server: VpnServer): boolean {
  return (
    server.uuid === "00000000-0000-0000-0000-000000000000" ||
    !server.address ||
    server.address === "127.0.0.1" ||
    server.address === "0.0.0.0" ||
    /истекла|expired/i.test(server.name)
  );
}

/**
 * Panel online metadata can lag behind real VLESS/Reality reachability.
 * Only sentinel/expired placeholders are not connectable; probes and xray
 * decide whether a normal server is actually reachable.
 */
export function isAvailableVpnServer(server: VpnServer): boolean {
  return !isSentinelServer(server);
}

function parseVlessUrl(url: string): VpnServer | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "vless:" || u.password) return null;
    const uuid = u.username;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      console.warn("[parseVlessUrl] missing uuid");
      return null;
    }
    const address = u.hostname;
    if (!isSafeVpnEndpoint(address)) {
      console.warn("[parseVlessUrl] missing host");
      return null;
    }
    const port = u.port ? parseInt(u.port, 10) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const rawName = u.hash ? decodeURIComponent(u.hash.slice(1)) : address;
    const name = rawName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || address;
    const p = u.searchParams;
    const flow = boundedVlessParam(p.get("flow"), 64);
    const security = boundedVlessParam(p.get("security"), 16) || "none";
    const sni = boundedVlessParam(p.get("sni"), 253);
    const fingerprint = boundedVlessParam(p.get("fp"), 32) || "chrome";
    const publicKey = boundedVlessParam(p.get("pbk"), 128);
    const shortId = boundedVlessParam(p.get("sid"), 32);
    const network = boundedVlessParam(p.get("type"), 16) || "tcp";
    const path = boundedVlessParam(p.get("path"), 2048);
    const mode = boundedVlessParam(p.get("mode"), 32);
    const spx = boundedVlessParam(p.get("spx"), 2048);
    if (
      [flow, security, sni, fingerprint, publicKey, shortId, network, path, mode, spx]
        .some((value) => value.includes("\0")) ||
      !["none", "tls", "reality"].includes(security) ||
      !["tcp", "ws", "xhttp"].includes(network) ||
      (flow !== "" && flow !== "xtls-rprx-vision") ||
      (sni !== "" && !isValidHostname(sni)) ||
      !/^[a-z0-9_-]{0,32}$/i.test(fingerprint) ||
      /[\u0000-\u001f\u007f]/.test(path + spx) ||
      !/^[a-z0-9_-]{0,32}$/i.test(mode)
    ) {
      return null;
    }
    if (
      security === "reality" &&
      (!sni ||
        !/^[a-z0-9_-]{20,128}$/i.test(publicKey) ||
        !/^(?:[0-9a-f]{2}){0,16}$/i.test(shortId))
    ) {
      return null;
    }

    return {
      id: `${address}:${port}:${sni}`,
      name,
      address,
      port,
      uuid,
      flow,
      security,
      sni,
      fingerprint,
      public_key: publicKey,
      short_id: shortId,
      network,
      path,
      mode,
      spx,
      country: "",
      isOnline: true,
      sortOrder: 0,
    };
  } catch {
    console.warn("[parseVlessUrl] parse error");
    return null;
  }
}

function boundedVlessParam(value: string | null, maxLength: number): string {
  const normalized = value?.trim() ?? "";
  return normalized.length <= maxLength ? normalized : "\0";
}

function isValidHostname(value: string): boolean {
  const host = value.toLocaleLowerCase("en-US").replace(/\.$/, "");
  return (
    host.length >= 2 &&
    host.length <= 253 &&
    host.includes(".") &&
    host.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-") &&
        /^[a-z0-9-]+$/.test(label),
    )
  );
}

function isSafeVpnEndpoint(value: string): boolean {
  if (!value || value.includes(":")) return false;
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) {
    return isValidHostname(value);
  }
  const parts = octets.map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function cloneVpnServers(servers: VpnServer[]): VpnServer[] {
  return servers.map((server) => ({ ...server }));
}

function writeVpnServersMemoryCache(shortUuid: string, servers: VpnServer[]): number {
  vpnServersCacheGeneration += 1;
  vpnServersMemoryCache = {
    shortUuid,
    servers: cloneVpnServers(servers),
  };
  window.dispatchEvent(new Event(VPN_SERVERS_EVENT));
  return vpnServersCacheGeneration;
}

function clearVpnServersMemoryCache(shortUuid: string | null): void {
  if (shortUuid && vpnServersMemoryCache && vpnServersMemoryCache.shortUuid !== shortUuid) return;
  const hadVisibleCache = vpnServersMemoryCache !== null;
  vpnServersCacheGeneration += 1;
  vpnServersMemoryCache = null;
  if (hadVisibleCache) window.dispatchEvent(new Event(VPN_SERVERS_EVENT));
}

function parseVpnServersFromLinks(links: string[]): VpnServer[] {
  const unique = new Map<string, VpnServer>();
  for (const link of links) {
    const server = parseVlessUrl(link);
    if (server && !isSentinelServer(server) && !unique.has(server.id)) {
      unique.set(server.id, server);
    }
  }
  return [...unique.values()];
}

function serverNameParts(name: string): ServerNameParts {
  const normalized = name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  const match = normalized.match(/^(.*?)[\s#_-]+(\d+)$/);
  if (!match) return { base: normalized, number: null };
  const parsedNumber = Number.parseInt(match[2], 10);
  return {
    base: match[1].trim(),
    number: Number.isFinite(parsedNumber) ? parsedNumber : null,
  };
}

function keepStableServerOrder(servers: VpnServer[], cachedServers: VpnServer[]): VpnServer[] {
  const compareFallback = (a: VpnServer, b: VpnServer): number => {
    const aParts = serverNameParts(a.name);
    const bParts = serverNameParts(b.name);
    return (
      aParts.base.localeCompare(bParts.base, "en-US") ||
      (aParts.number ?? Number.MAX_SAFE_INTEGER) -
        (bParts.number ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name, "en-US") ||
      a.id.localeCompare(b.id, "en-US")
    );
  };

  if (cachedServers.length === 0) {
    return [...servers].sort(compareFallback).map((server, index) => ({
      ...server,
      sortOrder: index,
    }));
  }

  const cachedPositionById = new Map(
    cachedServers.map((server, index) => [server.id, index] as const),
  );
  const cachedGroupPositionByName = new Map<string, number>();
  cachedServers.forEach((server, index) => {
    const base = serverNameParts(server.name).base;
    const current = cachedGroupPositionByName.get(base);
    if (current === undefined || index < current) {
      cachedGroupPositionByName.set(base, index);
    }
  });

  return servers
    .map((server, profileIndex) => {
      const nameParts = serverNameParts(server.name);
      const cachedPosition = cachedPositionById.get(server.id);
      const cachedGroupPosition = cachedGroupPositionByName.get(nameParts.base);
      const primaryPosition =
        nameParts.number !== null
          ? cachedGroupPosition ?? cachedPosition ?? Number.MAX_SAFE_INTEGER
          : cachedPosition ?? cachedGroupPosition ?? Number.MAX_SAFE_INTEGER;
      return {
        server,
        nameParts,
        profileIndex,
        primaryPosition,
      };
    })
    .sort((a, b) => {
      return (
        a.primaryPosition - b.primaryPosition ||
        a.nameParts.base.localeCompare(b.nameParts.base, "en-US") ||
        (a.nameParts.number ?? Number.MAX_SAFE_INTEGER) -
          (b.nameParts.number ?? Number.MAX_SAFE_INTEGER) ||
        a.server.name.localeCompare(b.server.name, "en-US") ||
        a.server.id.localeCompare(b.server.id, "en-US") ||
        a.profileIndex - b.profileIndex
      );
    })
    .map((entry, index) => ({
      ...entry.server,
      sortOrder: index,
    }));
}

function prepareVpnServersForCache(shortUuid: string, servers: VpnServer[]): VpnServer[] {
  const cachedServers =
    vpnServersMemoryCache?.shortUuid === shortUuid ? vpnServersMemoryCache.servers : [];
  return reuseCachedVpnServerMetadata(
    shortUuid,
    keepStableServerOrder(servers, cachedServers),
  );
}

function reuseCachedVpnServerMetadata(shortUuid: string, servers: VpnServer[]): VpnServer[] {
  if (vpnServersMemoryCache?.shortUuid !== shortUuid) return servers;

  const cachedById = new Map(
    vpnServersMemoryCache.servers.map((server) => [server.id, server]),
  );
  return servers.map((server) => {
    const cached = cachedById.get(server.id);
    if (!cached) return server;
    return {
      ...server,
      country: server.country || cached.country,
      isOnline: cached.isOnline,
      sortOrder: server.sortOrder,
    };
  });
}

function cacheVpnServersFromLinks(shortUuid: string, links: string[]): VpnServer[] {
  const servers = prepareVpnServersForCache(
    shortUuid,
    parseVpnServersFromLinks(links),
  );
  if (servers.length === 0) {
    clearVpnServersMemoryCache(shortUuid);
    return servers;
  }

  const generation = writeVpnServersMemoryCache(shortUuid, servers);
  void enrichVpnServersWithNodes(cloneVpnServers(servers))
    .then((enriched) => {
      if (
        getSession().shortUuid === shortUuid &&
        vpnServersCacheGeneration === generation
      ) {
        writeVpnServersMemoryCache(shortUuid, enriched);
      }
    })
    .catch(() => {});
  return servers;
}

export function getCachedVpnServers(): VpnServer[] {
  const { shortUuid } = getSession();
  if (!shortUuid || vpnServersMemoryCache?.shortUuid !== shortUuid) return [];
  return cloneVpnServers(vpnServersMemoryCache.servers);
}

export function subscribeVpnServers(listener: () => void): () => void {
  window.addEventListener(VPN_SERVERS_EVENT, listener);
  return () => window.removeEventListener(VPN_SERVERS_EVENT, listener);
}

async function enrichVpnServersWithNodes(servers: VpnServer[]): Promise<VpnServer[]> {
  const nodes = sanitizePanelNodes((await apiGetNodes()).response);
  const endpointKey = (address: string, port: number) =>
    `${address.toLocaleLowerCase("en-US")}:${port}`;
  const countryByEndpoint = new Map(
    nodes.map((node) => [endpointKey(node.address, node.port), node.country_code]),
  );
  const disabledEndpoints = new Set(
    nodes
      .filter((node) => node.is_disabled || !node.is_connected)
      .map((node) => endpointKey(node.address, node.port)),
  );

  return servers.map((server) => {
    const key = endpointKey(server.address, server.port);
    return {
      ...server,
      country: countryByEndpoint.get(key) || server.country,
      isOnline: server.isOnline && !disabledEndpoints.has(key),
    };
  });
}

/**
 * Fetch VPN servers from subscription links (VLESS URLs).
 * Mirrors TV's VpnRepository.refreshServers().
 */
export async function fetchVpnServers(
  opts: { skipAccessPing?: boolean } = {},
): Promise<VpnServer[]> {
  const session = getSession();
  const { shortUuid } = session;
  const expectedGeneration = getSessionGeneration();
  const expectedDeviceId = session.deviceId;
  const isCurrent = () => {
    const currentSession = getSession();
    return (
      getSessionGeneration() === expectedGeneration &&
      currentSession.deviceId === expectedDeviceId &&
      currentSession.shortUuid === shortUuid
    );
  };
  const currentCache = () => getCachedVpnServers();
  const debug = import.meta.env.DEV;
  if (!shortUuid) return [];
  if (isBrowserPreviewRuntime()) return getCachedVpnServers();
  if (getSubscriptionUsageBlocked()) {
    clearVpnServersMemoryCache(shortUuid);
    return [];
  }

  const blocked = opts.skipAccessPing
    ? getSubscriptionUsageBlocked()
    : await pingHwidOnly().catch(() => getSubscriptionUsageBlocked());
  if (!isCurrent()) return currentCache();
  if (blocked) {
    clearVpnServersMemoryCache(shortUuid);
    return [];
  }

  const subscriptionUrl = await readSubscriptionUrl(shortUuid, isCurrent);
  if (!isCurrent()) return currentCache();
  const profile = await fetchSubscriptionProfile(subscriptionUrl, shortUuid);
  if (!isCurrent()) return currentCache();
  if (profile) {
    setSubscriptionUsageBlocked(shortUuid, profile.isUsageBlocked);
    setUpdateRequired(profile.isUpdateRequired);
    writeSubSyncState(profile.intervalMs);
    if (profile.trafficLimitBytes !== null || profile.trafficUsedBytes !== null) {
      updateSession({
        trafficLimitBytes: profile.trafficLimitBytes ?? getSession().trafficLimitBytes,
        trafficUsedBytes: profile.trafficUsedBytes ?? getSession().trafficUsedBytes,
      });
    }
    if (profile.isUsageBlocked) {
      clearVpnServersMemoryCache(shortUuid);
      return [];
    }
    if (debug) console.log("[fetchVpnServers] profile links count:", profile.links.length);
  }

  if (!profile) {
    return getCachedVpnServers();
  }

  const links = profile.links;
  if (links.length === 0) {
    // Mirror runSyncSubscription: only a SUCCESSFUL empty profile means the
    // subscription really has no servers. An error body (e.g. a proxy's 502
    // HTML page) has no links either — keep the cached list instead of
    // wiping it over a transient panel failure.
    if (profile.isSuccessful) {
      clearVpnServersMemoryCache(shortUuid);
      return [];
    }
    return getCachedVpnServers();
  }

  const servers = prepareVpnServersForCache(
    shortUuid,
    parseVpnServersFromLinks(links),
  );

  if (debug) console.log("[fetchVpnServers] Parsed servers:", servers.length, "of", links.length);
  const generation = writeVpnServersMemoryCache(shortUuid, servers);

  const metadataTask = enrichVpnServersWithNodes(cloneVpnServers(servers));
  metadataTask
    .then((enriched) => {
      if (
        getSession().shortUuid === shortUuid &&
        vpnServersCacheGeneration === generation
      ) {
        writeVpnServersMemoryCache(shortUuid, enriched);
      }
    })
    .catch(() => {
      if (debug) console.warn("[fetchVpnServers] nodes enrichment failed");
    });

  const enriched = await settleStartupStep(
    "serverMetadata",
    metadataTask,
    SERVER_METADATA_TIMEOUT_MS,
  );
  if (!isCurrent()) return currentCache();
  if (enriched) {
    if (isCurrent() && vpnServersCacheGeneration === generation) {
      writeVpnServersMemoryCache(shortUuid, enriched);
    }
    return cloneVpnServers(enriched);
  }

  return cloneVpnServers(servers);
}

export type { Session };
