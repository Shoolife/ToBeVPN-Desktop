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
  getSubscriptionInfo,
  getUserByTelegramId,
  logoutDevice,
  requestAuth,
  registerDevice,
  resetSubscription,
  saveEmail as apiSaveEmail,
  unlinkDevice,
} from "../api/client";
import type {
  AuthStatusDto,
  CurrentPlanDto,
  LinkedDeviceDto,
  LinkedDevicesDto,
  PanelNodeDto,
  PanelResponse,
  PanelSubInfoDto,
  PanelUserDto,
  PurchasePlansDto,
  TvPairStatusDto,
} from "../api/types";
import {
  clearDeviceSession,
  clearIdentity,
  applySessionSecrets,
  getSession,
  getSessionSecrets,
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
import { disconnectVpn } from "./vpnState";
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
const UPDATE_REQUIRED_KEY = "tobevpn_update_required_v1";
const SUBSCRIPTION_ACCESS_EVENT = "tobevpn:subscription-access-changed";
const PENDING_PURCHASE_KEY = "tobevpn_pending_purchase_v1";
const PENDING_AUTH_TOKEN_KEY = "tobevpn_pending_auth_token_v1";
const VPN_SERVERS_EVENT = "tobevpn:vpn-servers-changed";
// 12h matches the default surfaced in the panel's "subscription
// auto-refresh" panel field. Used until the first successful ping
// returns a `profile-update-interval` value.
const DEFAULT_SUB_INTERVAL_MS = 12 * 60 * 60 * 1000;

const PURCHASE_REFRESH_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const PURCHASE_REFRESH_TOTAL_WINDOW_MS = 10 * 60 * 1000;
const PURCHASE_REFRESH_INTERVAL_MS = 3_000;
const PURCHASE_REFRESH_SLOW_INTERVAL_MS = 30_000;
const PURCHASE_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const SERVER_METADATA_TIMEOUT_MS = 250;

// Single in-flight syncSubscription. Concurrent callers (vpnState.connectVpn,
// HomeScreen useEffect, manual refresh) all await the same promise so we
// never fire two parallel /api/panel/sub/.../info round-trips.
let syncInFlight: Promise<void> | null = null;
let pendingPurchaseRefresh: Promise<void> | null = null;
const subscriptionInfoInFlight = new Map<string, Promise<PanelResponse<PanelSubInfoDto>>>();
let vpnServersMemoryCache: {
  shortUuid: string;
  servers: VpnServer[];
} | null = null;
let vpnServersCacheGeneration = 0;

interface PendingPurchaseState {
  startedAt: number;
  baselinePlan: UserPlan | null;
  baselineExpiresAt: number | null;
}

function readSubInterval(): number {
  try {
    const raw = localStorage.getItem(SUB_INTERVAL_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUB_INTERVAL_MS;
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
    const interval = intervalMs ?? readSubInterval();
    localStorage.setItem(SUB_SYNC_AT_KEY, String(Date.now()));
    localStorage.setItem(SUB_INTERVAL_KEY, String(interval));
  } catch {
    // localStorage can fail in private-mode webviews; the next call falls
    // back to the default interval, which is the safest behaviour.
  }
}

function readCachedSubscriptionUrl(shortUuid: string): string | null {
  try {
    // v1 stored only a URL. It can belong to a previous account after
    // auth/logout and must never be used to decide access for this session.
    localStorage.removeItem(LEGACY_SUB_URL_CACHE_KEY);
    const raw = localStorage.getItem(SUB_URL_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { shortUuid?: unknown; url?: unknown };
    return cached.shortUuid === shortUuid && typeof cached.url === "string" && cached.url
      ? cached.url
      : null;
  } catch {
    return null;
  }
}

function writeCachedSubscriptionUrl(shortUuid: string, url: string | null): void {
  try {
    localStorage.removeItem(LEGACY_SUB_URL_CACHE_KEY);
    if (url) {
      localStorage.setItem(SUB_URL_CACHE_KEY, JSON.stringify({ shortUuid, url }));
      return;
    }
    const raw = localStorage.getItem(SUB_URL_CACHE_KEY);
    if (!raw) return;
    try {
      const cached = JSON.parse(raw) as { shortUuid?: unknown };
      if (cached.shortUuid === shortUuid) {
        localStorage.removeItem(SUB_URL_CACHE_KEY);
      }
    } catch {
      localStorage.removeItem(SUB_URL_CACHE_KEY);
    }
  } catch {
    // ignore — see writeSubSyncState
  }
}

function setSubscriptionUsageBlocked(shortUuid: string, blocked: boolean): void {
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
  try {
    return localStorage.getItem(BLOCKED_SUBSCRIPTION_KEY) === shortUuid;
  } catch {
    return false;
  }
}

export function getSubscriptionUsageBlocked(): boolean {
  return isSubscriptionUsageBlocked(getSession().shortUuid);
}

export function getUpdateRequired(): boolean {
  try {
    return localStorage.getItem(UPDATE_REQUIRED_KEY) === "yes";
  } catch {
    return false;
  }
}

function setUpdateRequired(required: boolean): void {
  const was = getUpdateRequired();
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

function getSubscriptionInfoShared(shortUuid: string): Promise<PanelResponse<PanelSubInfoDto>> {
  const existing = subscriptionInfoInFlight.get(shortUuid);
  if (existing) return existing;

  const task = getSubscriptionInfo(shortUuid).finally(() => {
    if (subscriptionInfoInFlight.get(shortUuid) === task) {
      subscriptionInfoInFlight.delete(shortUuid);
    }
  });
  subscriptionInfoInFlight.set(shortUuid, task);
  return task;
}

function readPendingPurchaseState(): PendingPurchaseState | null {
  try {
    const raw = localStorage.getItem(PENDING_PURCHASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPurchaseState>;
    if (typeof parsed.startedAt !== "number") return null;
    return {
      startedAt: parsed.startedAt,
      baselinePlan:
        parsed.baselinePlan === "PAID" ||
        parsed.baselinePlan === "ADMIN" ||
        parsed.baselinePlan === "FREE_TRIAL" ||
        parsed.baselinePlan === "EXPIRED"
          ? parsed.baselinePlan
          : null,
      baselineExpiresAt:
        typeof parsed.baselineExpiresAt === "number" ? parsed.baselineExpiresAt : null,
    };
  } catch {
    return null;
  }
}

export function markPendingPurchaseStarted(input: {
  baselinePlan?: UserPlan | null;
  baselineExpiresAt?: number | null;
} = {}): void {
  const state: PendingPurchaseState = {
    startedAt: Date.now(),
    baselinePlan: input.baselinePlan ?? null,
    baselineExpiresAt: input.baselineExpiresAt ?? null,
  };
  try {
    localStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify(state));
  } catch {
    // If persistence fails, the in-session refresh still starts below.
  }
}

export function clearPendingPurchase(): void {
  try {
    localStorage.removeItem(PENDING_PURCHASE_KEY);
  } catch {
    // ignore
  }
}

export function getPendingAuthToken(): string | null {
  try {
    const token = localStorage.getItem(PENDING_AUTH_TOKEN_KEY);
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

export function clearPendingAuthToken(): void {
  try {
    localStorage.removeItem(PENDING_AUTH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

function writePendingAuthToken(token: string): void {
  try {
    localStorage.setItem(PENDING_AUTH_TOKEN_KEY, token);
  } catch {
    // ignore — PairingScreen still keeps the token in memory.
  }
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
  const squads = user.active_internal_squads.map((s) => s.name.toUpperCase());
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
  hasPlanData: boolean;
  subscriptionUrl: string | null;
}

function normalizePlanTrafficLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value <= 0) return 0;
  return value > 1024 * 1024 ? value : value * 1024 * 1024 * 1024;
}

function normalizeTrafficLimitBytes(
  trafficLimitBytes: number | null | undefined,
  trafficLimit: number | null | undefined,
): number | null {
  if (trafficLimitBytes !== null && trafficLimitBytes !== undefined) return trafficLimitBytes;
  return normalizePlanTrafficLimit(trafficLimit);
}

function epochTimestampToMillis(value: number | null | undefined): number | null {
  const timestamp = value && value > 0 ? value : null;
  if (timestamp === null) return null;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function currentPlanInfoFromDto(dto: CurrentPlanDto | null | undefined): CurrentSubscriptionPlanInfo | null {
  if (!dto) return null;
  const snapshot = dto.current_plan ?? dto.plan_snapshot ?? null;
  const subscription = dto.subscription ?? null;
  const subscriptionStatus = subscription?.status ?? subscription?.stored_status ?? dto.status ?? null;
  const expiresAtMillis =
    epochTimestampToMillis(subscription?.expire_at_ts) ??
    parseExpiresAtMillis(subscription?.expire_at) ??
    parseExpiresAtMillis(subscription?.expires_at) ??
    parseExpiresAtMillis(dto.expire_at) ??
    parseExpiresAtMillis(dto.expires_at);
  const isExpired =
    subscription?.is_expired ??
    (subscriptionStatus ? subscriptionStatus.toUpperCase() === "EXPIRED" : null) ??
    (expiresAtMillis !== null ? expiresAtMillis <= Date.now() : null);
  const isActive =
    subscription?.is_active ??
    (subscriptionStatus ? subscriptionStatus.toUpperCase() === "ACTIVE" : null);
  const hasPlanData = Boolean(snapshot || subscription || dto.plan_name?.trim() || dto.name?.trim());
  const displayName =
    (snapshot?.name ?? dto.plan_name ?? dto.name ?? "").trim() || null;
  return {
    displayName,
    trafficLimitBytes:
      normalizeTrafficLimitBytes(subscription?.traffic_limit_bytes, subscription?.traffic_limit) ??
      normalizeTrafficLimitBytes(snapshot?.traffic_limit_bytes, snapshot?.traffic_limit),
    deviceLimit: subscription?.device_limit ?? snapshot?.device_limit ?? null,
    expiresAtMillis,
    isActive,
    isExpired,
    isTrial: subscription?.is_trial ?? snapshot?.is_trial ?? null,
    isUnlimited: subscription?.is_unlimited ?? (snapshot?.type ? snapshot.type.toUpperCase() === "UNLIMITED" : null),
    hasPlanData,
    subscriptionUrl: (subscription?.url ?? "").trim() || null,
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

function parseExpiresAtMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
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

function deviceMatchesAliases(device: LinkedDeviceDto, aliases: string[]): boolean {
  const normalized = new Set(
    aliases.map((alias) => alias.trim().toLocaleLowerCase("en-US")).filter(Boolean),
  );
  return [device.device_id, device.hwid].some((value) => {
    const normalizedValue = value?.trim().toLocaleLowerCase("en-US");
    return !!normalizedValue && normalized.has(normalizedValue);
  });
}

export async function unlinkCurrentDevice(): Promise<void> {
  const aliases = await getCurrentDeviceAliases();
  let lastError: Error | null = null;
  let succeeded = false;
  for (const deviceId of aliases) {
    try {
      const res = await unlinkDevice({ device_id: deviceId });
      if (res.success) {
        succeeded = true;
        continue;
      }
      lastError = new Error(res.message ?? "Could not unlink device");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Could not unlink device");
    }
  }
  if (succeeded) return;
  throw lastError ?? new Error("Could not unlink device");
}

export interface PairingCode {
  authToken: string;
  qrUrl: string;
}

export interface DevicePairingCode {
  code: string;
  expiresIn: number;
}

export async function createPairingCode(): Promise<PairingCode> {
  await ensureDeviceSession();
  const session = getSession();
  const res = await requestAuth({
    panel_user_uuid: session.panelUserUuid,
  });
  if (!res.success || !res.data) throw new Error(res.message ?? "Empty auth response");

  const authToken = res.data.auth_token;
  writePendingAuthToken(authToken);
  const qrUrl = getPairingOpenTargets(authToken).browserUrl;
  return { authToken, qrUrl };
}

export async function createDevicePairingCode(): Promise<DevicePairingCode> {
  await ensureDeviceSession();
  const res = await createTvPairing({});
  if (!res.success || !res.data) throw new Error(res.message ?? "Empty pairing response");
  return {
    code: res.data.code,
    expiresIn: res.data.expires_in,
  };
}

export function getPairingOpenTargets(authToken: string): {
  desktopUrl: string;
  browserUrl: string;
} {
  const encodedToken = encodeURIComponent(authToken);
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
  const res = await checkAuthStatus(authToken);
  if (!res.success || !res.data) {
    const message = res.message ?? "Auth token not found";
    if (/not found|expired/i.test(message)) return { status: "expired" };
    throw new Error(message);
  }
  const data = res.data;
  if (data.status === "completed") {
    if (!data.telegram_id) throw new Error("Pairing completed without telegram_id");
    return { status: "completed", payload: data };
  }
  return { status: "pending" };
}

export async function pollDevicePairing(code: string): Promise<DevicePairingPollResult> {
  const res = await checkTvPairingStatus(code);
  if (!res.success || !res.data) {
    const message = res.message ?? "Pairing code not found";
    if (/not found|expired/i.test(message)) return { status: "expired" };
    throw new Error(message);
  }
  const data = res.data;
  if (data.status === "completed") {
    if (!data.telegram_id) throw new Error("Pairing completed without telegram_id");
    return { status: "completed", payload: data };
  }
  if (data.status === "expired") return { status: "expired" };
  if (data.status === "rejected") throw new Error(res.message ?? "Pairing was rejected");
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
  markLinkedIdentity({
    telegramId,
    shortUuid: preferredShortUuid,
    panelUserUuid: preferredPanelUserUuid,
  });

  await bootstrapDeviceSession().catch(() => {});

  // Force the sync — we just authenticated and the user expects to
  // immediately see the right plan (PAID / FREE_TRIAL), not whatever
  // was cached pre-login.
  await syncSubscription({ force: true });
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
  if (syncInFlight) return syncInFlight;
  if (!force) {
    const last = readSubLastSyncAt();
    if (last > 0 && Date.now() - last < readSubInterval()) return;
  }
  syncInFlight = runSyncSubscription().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

export function startPendingPurchaseRefreshIfNeeded(): void {
  if (pendingPurchaseRefresh) return;
  const pending = readPendingPurchaseState();
  if (!pending) return;

  pendingPurchaseRefresh = runPendingPurchaseRefresh(pending).finally(() => {
    pendingPurchaseRefresh = null;
  });
}

/**
 * Bare HWID-marker ping — used by the connect path so the panel registers
 * the device on every VPN start. It prefers the subscription URL cached by
 * syncSubscription, but resolves it through the JSON panel endpoint when the
 * cache is empty. Otherwise a fresh install / startup race could connect
 * before the access-block header is ever checked.
 */
export async function pingHwidOnly(): Promise<boolean> {
  const shortUuid = getSession().shortUuid;
  const wasBlocked = isSubscriptionUsageBlocked(shortUuid);
  if (!shortUuid) return wasBlocked;
  const url = await readOrFetchSubscriptionUrl(shortUuid);
  if (!url) return wasBlocked;
  try {
    const result = await pingSubscriptionUrl(url);
    if (!result) return wasBlocked;
    setSubscriptionUsageBlocked(shortUuid, result.isUsageBlocked);
    setUpdateRequired(result.isUpdateRequired);
    return result.isUsageBlocked;
  } catch {
    return wasBlocked;
  }
}

async function readOrFetchSubscriptionUrl(shortUuid: string): Promise<string | null> {
  const cached = readCachedSubscriptionUrl(shortUuid);
  if (cached) return cached;
  if (getSession().isLinked) {
    const currentPlanInfo = await fetchCurrentSubscriptionPlan();
    if (currentPlanInfo?.subscriptionUrl) {
      writeCachedSubscriptionUrl(shortUuid, currentPlanInfo.subscriptionUrl);
      return currentPlanInfo.subscriptionUrl;
    }
  }
  try {
    const subInfo = (await getSubscriptionInfoShared(shortUuid)).response;
    if (!subInfo.is_found || !subInfo.user) {
      writeCachedSubscriptionUrl(shortUuid, null);
      if (getSession().shortUuid === shortUuid) {
        updateSession({
          userPlan: "EXPIRED",
          planExpiresAt: null,
          trafficLimitBytes: 0,
          trafficUsedBytes: 0,
        });
      }
      return null;
    }
    writeCachedSubscriptionUrl(shortUuid, subInfo.subscription_url);
    return subInfo.subscription_url;
  } catch {
    return null;
  }
}

async function runSyncSubscription(): Promise<void> {
  let session = getSession();

  const telegramId = session.telegramId;

  let panelUser: PanelUserDto | null = null;
  let currentPlanInfo: CurrentSubscriptionPlanInfo | null = null;
  if (session.isLinked && telegramId !== null) {
    try {
    const { response: panelUsers } = await getUserByTelegramId(telegramId);
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
  }

  const shortUuid = session.shortUuid;
  if (!shortUuid) return;

  let legacySubInfo: PanelSubInfoDto | null = null;
  let subUser: PanelSubInfoDto["user"] = null;
  let subscriptionUrl: string | null =
    currentPlanInfo?.subscriptionUrl ??
    panelUser?.subscription_url ??
    readCachedSubscriptionUrl(shortUuid);
  let serverLinks: string[] = [];
  let profileResult: SubscriptionProfileResult | null = null;

  const loadLegacyInfo = async (): Promise<PanelSubInfoDto | null> => {
    const info = (await getSubscriptionInfoShared(shortUuid)).response;
    if (!info.is_found || !info.user) return null;
    return info;
  };

  // Keep the old JSON endpoint only as a compatibility path for metadata or
  // older sessions that don't yet expose a subscription URL.
  if (!subscriptionUrl || (!currentPlanInfo && !panelUser)) {
    try {
      legacySubInfo = await loadLegacyInfo();
      subUser = legacySubInfo?.user ?? null;
      subscriptionUrl = subscriptionUrl ?? legacySubInfo?.subscription_url ?? null;
      serverLinks = legacySubInfo?.links ?? [];
    } catch {
      if (!subscriptionUrl) return;
    }
  }

  if (subscriptionUrl) {
    try {
      profileResult = await fetchSubscriptionProfile(subscriptionUrl);
    } catch {
      profileResult = null;
    }
  }

  if (profileResult) {
    setSubscriptionUsageBlocked(shortUuid, profileResult.isUsageBlocked);
    setUpdateRequired(profileResult.isUpdateRequired);
    writeSubSyncState(profileResult.intervalMs);
    if (profileResult.links.length > 0) {
      serverLinks = profileResult.links;
    } else if (profileResult.isSuccessful || profileResult.isUsageBlocked) {
      serverLinks = [];
    }
  } else if (subscriptionUrl) {
    clearSubSyncTimestamp();
  }

  if (!subUser && !currentPlanInfo && !legacySubInfo) {
    try {
      legacySubInfo = await loadLegacyInfo();
      subUser = legacySubInfo?.user ?? null;
      subscriptionUrl = subscriptionUrl ?? legacySubInfo?.subscription_url ?? null;
      if (serverLinks.length === 0) serverLinks = legacySubInfo?.links ?? [];
    } catch {
      // Keep profile-derived links/traffic if legacy metadata is unavailable.
    }
  }

  if (!subscriptionUrl && !subUser && !currentPlanInfo) {
    writeCachedSubscriptionUrl(shortUuid, null);
    clearVpnServersMemoryCache(shortUuid);
    updateSession({
      userPlan: "EXPIRED",
      planDisplayName: null,
      planExpiresAt: null,
      trafficLimitBytes: 0,
      trafficUsedBytes: 0,
    });
    return;
  }

  writeCachedSubscriptionUrl(shortUuid, subscriptionUrl);
  if (profileResult?.isUsageBlocked) {
    clearVpnServersMemoryCache(shortUuid);
  } else if (serverLinks.length > 0 || profileResult?.isSuccessful) {
    cacheVpnServersFromLinks(shortUuid, serverLinks);
  }

  if (!subUser && currentPlanInfo) {
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
    });
    try {
      await registerCurrentDevice();
    } catch {
      // ignore
    }
    return;
  }

  if (!subUser) return;

  const isActive = subUser.is_active && subUser.user_status === "ACTIVE";
  const cachedPlan = session.userPlan;

  // Plan derivation order:
  //   1. Inactive subscription => EXPIRED, regardless of cache.
  //   2. Panel data with a non-trivial squad (ADMIN / PAID) wins.
  //   3. MONTH-strategy traffic limit is the canonical "paid" signal in the
  //      subscription payload — trust it even if the panel payload arrived
  //      without a squad list.
  //   4. Never silently downgrade an already-PAID/ADMIN cached plan to
  //      FREE_TRIAL on a transient/ambiguous response (this used to flip
  //      the badge to "Пробный" while server-switching).
  let plan: UserPlan;
  if (currentPlanInfo) {
    plan = resolvePlanFromCurrentPlan(cachedPlan, currentPlanInfo);
  } else if (!isActive) {
    plan = "EXPIRED";
  } else if (panelUser && planForPanelUser(panelUser) !== "FREE_TRIAL") {
    plan = planForPanelUser(panelUser);
  } else if (subUser.traffic_limit_strategy === "MONTH") {
    plan = "PAID";
  } else if (cachedPlan === "PAID" || cachedPlan === "ADMIN") {
    plan = cachedPlan;
  } else {
    plan = "FREE_TRIAL";
  }

  const expiresAtMillis = currentPlanInfo?.expiresAtMillis ?? parseExpiresAtMillis(subUser.expires_at);
  const trafficLimitBytes =
    profileResult?.trafficLimitBytes ??
    currentPlanInfo?.trafficLimitBytes ??
    (Number(subUser.traffic_limit_bytes) || 0);
  const trafficUsedBytes =
    profileResult?.trafficUsedBytes ??
    (Number(subUser.traffic_used_bytes) || 0);

  updateSession({
    userPlan: plan,
    planDisplayName:
      currentPlanInfo?.displayName ??
      (session.userPlan === plan && plan !== "EXPIRED" ? session.planDisplayName : null),
    planExpiresAt: expiresAtMillis,
    trafficLimitBytes,
    trafficUsedBytes,
  });

  // Refresh "last seen" on the device row so it surfaces in linked-devices listings.
  try {
    await registerCurrentDevice();
  } catch {
    // ignore
  }
}

async function runPendingPurchaseRefresh(initial: PendingPurchaseState): Promise<void> {
  const maxDeadline = initial.startedAt + PURCHASE_PENDING_MAX_AGE_MS;
  const now = Date.now();
  if (now > maxDeadline) {
    expirePendingPurchase();
    return;
  }

  const activeDeadline = Math.min(now + PURCHASE_REFRESH_ACTIVE_WINDOW_MS, maxDeadline);
  while (Date.now() <= activeDeadline) {
    await refreshSubscriptionAfterPurchase();
    if (paymentLooksApplied(initial, getSession())) {
      clearPendingPurchase();
      return;
    }
    await sleepMs(PURCHASE_REFRESH_INTERVAL_MS);
  }

  const totalDeadline = Math.min(now + PURCHASE_REFRESH_TOTAL_WINDOW_MS, maxDeadline);
  while (Date.now() <= totalDeadline) {
    await sleepMs(PURCHASE_REFRESH_SLOW_INTERVAL_MS);
    await refreshSubscriptionAfterPurchase();
    if (paymentLooksApplied(initial, getSession())) {
      clearPendingPurchase();
      return;
    }
  }

  if (Date.now() > maxDeadline) {
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
  try {
    const aliases = await getCurrentDeviceAliases();
    const res = await apiGetDevices();
    if (!res.success || !res.data) return "unknown";
    return res.data.devices.some((device) => deviceMatchesAliases(device, aliases))
      ? "linked"
      : "missing";
  } catch (error) {
    return isRemoteDeviceUnlinkedError(error) ? "missing" : "unknown";
  }
}

export async function isCurrentDeviceLinked(): Promise<boolean> {
  return (await checkCurrentDeviceLinkStatus()) !== "missing";
}

const DEVICE_LINK_POLL_MS = 60_000;
const DEVICE_LINK_MISS_THRESHOLD = 3;
const DEVICE_LINK_INITIAL_MISS_THRESHOLD = 5;
let linkPollTimer: number | null = null;
let linkPollCurrentDeviceSeen = false;
let linkPollMissingCount = 0;

function resetDeviceLinkPollState() {
  linkPollCurrentDeviceSeen = false;
  linkPollMissingCount = 0;
}

/**
 * Start polling to detect remote device removal.
 * When the device is no longer linked, clears local session via clearIdentity().
 * Navigation is handled reactively by App.tsx observing useSession().
 */
export function startDeviceLinkPolling() {
  stopDeviceLinkPolling();

  const tick = async () => {
    const session = getSession();
    if (!session.isLinked) {
      stopDeviceLinkPolling();
      return;
    }
    const status = await checkCurrentDeviceLinkStatus();
    if (status === "linked") {
      linkPollCurrentDeviceSeen = true;
      linkPollMissingCount = 0;
      linkPollTimer = window.setTimeout(tick, DEVICE_LINK_POLL_MS);
      return;
    }
    if (status === "unknown") {
      linkPollTimer = window.setTimeout(tick, DEVICE_LINK_POLL_MS);
      return;
    }

    linkPollMissingCount += 1;
    const threshold = linkPollCurrentDeviceSeen
      ? DEVICE_LINK_MISS_THRESHOLD
      : DEVICE_LINK_INITIAL_MISS_THRESHOLD;
    if (linkPollMissingCount >= threshold) {
      // Tear down the tunnel before clearing identity — otherwise the OS-level
      // VPN keeps routing traffic after the user is bounced to the QR screen,
      // and the next pairing would re-enter Home with the connection still up.
      try {
        await disconnectVpn();
      } catch {
        // ignore — proceed to wipe local state regardless
      }
      clearVpnServersMemoryCache(session.shortUuid);
      clearIdentity();
      stopDeviceLinkPolling();
      return;
    }
    linkPollTimer = window.setTimeout(tick, DEVICE_LINK_POLL_MS);
  };

  linkPollTimer = window.setTimeout(tick, DEVICE_LINK_POLL_MS);
}

export function stopDeviceLinkPolling() {
  if (linkPollTimer !== null) {
    clearTimeout(linkPollTimer);
    linkPollTimer = null;
  }
  resetDeviceLinkPollState();
}

export async function logout(): Promise<void> {
  const { isLinked, shortUuid } = getSession();
  // Always tear down the tunnel first — clearing identity alone would leave
  // a live VPN session orphaned in the background.
  try {
    await disconnectVpn();
  } catch {
    // ignore — proceed even if backend already stopped
  }
  if (isLinked) {
    try {
      await unlinkCurrentDevice();
    } catch {
      // ignore — clear local state regardless
    }
  }
  try {
    await logoutDevice();
  } catch {
    // ignore — local session is cleared regardless
  }
  await clearSecureSession();
  clearPendingPurchase();
  clearPendingAuthToken();
  clearVpnServersMemoryCache(shortUuid);
  clearDeviceSession();
}

// --- Pass-through helpers used by screens ---

export async function fetchNodes(): Promise<PanelNodeDto[]> {
  return (await apiGetNodes()).response;
}

export async function fetchDevices(): Promise<LinkedDevicesDto | null> {
  const { isLinked } = getSession();
  if (!isLinked) return null;
  await pingHwidOnly().catch(() => false);
  const res = await apiGetDevices();
  if (!res.success || !res.data) return null;
  return res.data;
}

export async function unlinkOtherDevice(deviceId: string): Promise<void> {
  const { isLinked } = getSession();
  if (!isLinked) throw new Error("Not authenticated");
  const res = await unlinkDevice({ device_id: deviceId });
  if (!res.success) throw new Error(res.message ?? "Could not unlink device");
  await resetSubscriptionAfterDeviceUnlink();
}

async function resetSubscriptionAfterDeviceUnlink(): Promise<void> {
  const session = getSession();
  const oldShortUuid = session.shortUuid;
  if (!oldShortUuid) return;

  const res = await resetSubscription(oldShortUuid);
  if (!res.success || !res.data) {
    throw new Error(res.message ?? "Could not reset subscription link");
  }

  const data = res.data;
  const nextShortUuid = data.short_uuid?.trim() || oldShortUuid;
  const nextUrl = data.subscription_url?.trim() || null;

  if (nextShortUuid !== oldShortUuid) {
    writeCachedSubscriptionUrl(oldShortUuid, null);
    clearVpnServersMemoryCache(oldShortUuid);
  }
  writeCachedSubscriptionUrl(nextShortUuid, nextUrl);
  clearVpnServersMemoryCache(nextShortUuid);
  clearSubSyncTimestamp();

  updateSession({
    shortUuid: nextShortUuid,
    panelUserUuid: data.panel_user_uuid ?? session.panelUserUuid,
    telegramId: data.telegram_id ?? session.telegramId,
    trafficLimitBytes: data.traffic_limit_bytes ?? session.trafficLimitBytes,
    trafficUsedBytes: data.traffic_used_bytes ?? session.trafficUsedBytes,
  });

  await fetchVpnServers({ skipAccessPing: true }).catch(() => []);
}

export async function saveEmail(email: string): Promise<void> {
  const { isLinked, panelUserUuid } = getSession();
  if (!isLinked) throw new Error("Not authenticated");
  const res = await apiSaveEmail({ panel_user_uuid: panelUserUuid, email });
  if (!res.success) throw new Error(res.message ?? "Could not save email");
  updateSession({ email });
}

export async function fetchPurchasePlans(): Promise<PurchasePlansDto | null> {
  const { isLinked } = getSession();
  if (!isLinked) return null;
  if (await pingHwidOnly().catch(() => getSubscriptionUsageBlocked())) return null;
  const res = await apiGetPurchasePlans();
  if (!res.success || !res.data) return null;
  return res.data;
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

/** Server metadata allows the client to select and use this entry. */
export function isAvailableVpnServer(server: VpnServer): boolean {
  return server.isOnline && !isSentinelServer(server);
}

function parseVlessUrl(url: string): VpnServer | null {
  if (!url.startsWith("vless://")) return null;
  try {
    const u = new URL(url);
    const uuid = u.username;
    if (!uuid) {
      console.warn("[parseVlessUrl] missing uuid");
      return null;
    }
    const address = u.hostname;
    if (!address) {
      console.warn("[parseVlessUrl] missing host");
      return null;
    }
    const port = u.port ? parseInt(u.port, 10) : 443;
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : address;
    const p = u.searchParams;
    const sni = p.get("sni") ?? "";

    return {
      id: `${address}:${port}:${sni}`,
      name,
      address,
      port,
      uuid,
      flow: p.get("flow") ?? "",
      security: p.get("security") ?? "none",
      sni,
      fingerprint: p.get("fp") ?? "chrome",
      public_key: p.get("pbk") ?? "",
      short_id: p.get("sid") ?? "",
      network: p.get("type") ?? "tcp",
      path: p.get("path") ?? "",
      mode: p.get("mode") ?? "",
      spx: p.get("spx") ?? "",
      country: "",
      isOnline: true,
    };
  } catch {
    console.warn("[parseVlessUrl] parse error");
    return null;
  }
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
  if (!shortUuid || vpnServersMemoryCache?.shortUuid === shortUuid) {
    vpnServersCacheGeneration += 1;
    vpnServersMemoryCache = null;
  }
}

function parseVpnServersFromLinks(links: string[]): VpnServer[] {
  return links
    .map(parseVlessUrl)
    .filter((server): server is VpnServer => server !== null)
    .filter((server) => !isSentinelServer(server));
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
    };
  });
}

function cacheVpnServersFromLinks(shortUuid: string, links: string[]): VpnServer[] {
  const servers = reuseCachedVpnServerMetadata(
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
  const nodes = (await apiGetNodes()).response;
  const countryByAddress = new Map(nodes.map((n) => [n.address, n.country_code]));
  const disabledAddresses = new Set(
    nodes.filter((n) => n.is_disabled || !n.is_connected).map((n) => n.address),
  );

  return servers.map((server) => ({
    ...server,
    country: countryByAddress.get(server.address) ?? server.country,
    isOnline: server.isOnline && !disabledAddresses.has(server.address),
  }));
}

/**
 * Fetch VPN servers from subscription links (VLESS URLs).
 * Mirrors TV's VpnRepository.refreshServers().
 */
export async function fetchVpnServers(
  opts: { skipAccessPing?: boolean } = {},
): Promise<VpnServer[]> {
  const { shortUuid } = getSession();
  const debug = import.meta.env.DEV;
  if (!shortUuid) return [];
  if (getSubscriptionUsageBlocked()) {
    clearVpnServersMemoryCache(shortUuid);
    return [];
  }

  const blocked = opts.skipAccessPing
    ? getSubscriptionUsageBlocked()
    : await pingHwidOnly().catch(() => getSubscriptionUsageBlocked());
  if (blocked) {
    clearVpnServersMemoryCache(shortUuid);
    return [];
  }

  let links: string[] = [];
  const subscriptionUrl = await readOrFetchSubscriptionUrl(shortUuid);
  const profile = await fetchSubscriptionProfile(subscriptionUrl);
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
    links = profile.links;
    if (debug) console.log("[fetchVpnServers] profile links count:", links.length);
  }

  if (links.length === 0 && !profile?.isSuccessful) {
    const subInfoResponse = await getSubscriptionInfoShared(shortUuid);
    const subInfo = subInfoResponse.response;
    if (debug) console.log("[fetchVpnServers] legacy is_found:", subInfo.is_found, "links count:", subInfo.links?.length ?? 0);
    if (!subInfo.is_found || !subInfo.links?.length) {
      clearVpnServersMemoryCache(shortUuid);
      return [];
    }
    writeCachedSubscriptionUrl(shortUuid, subInfo.subscription_url ?? subscriptionUrl);
    links = subInfo.links;
  }

  if (links.length === 0) {
    clearVpnServersMemoryCache(shortUuid);
    return [];
  }

  const servers = reuseCachedVpnServerMetadata(
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
  if (enriched) {
    if (vpnServersCacheGeneration === generation) {
      writeVpnServersMemoryCache(shortUuid, enriched);
    }
    return cloneVpnServers(enriched);
  }

  return cloneVpnServers(servers);
}

export type { Session };
