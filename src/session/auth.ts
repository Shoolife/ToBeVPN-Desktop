// Higher-level operations on top of the API client + local session.
// Mirrors the Kotlin AuthRepository on the TV/phone clients.
import { invoke } from "@tauri-apps/api/core";
import {
  checkAuthStatus,
  getDevices as apiGetDevices,
  getNodes as apiGetNodes,
  getPurchasePlans as apiGetPurchasePlans,
  getSubscriptionInfo,
  getUserByTelegramId,
  logoutDevice,
  requestAuth,
  registerDevice,
  saveEmail as apiSaveEmail,
  syncDeviceSessionState,
  unlinkDevice,
} from "../api/client";
import type {
  AuthStatusDto,
  LinkedDevicesDto,
  PanelNodeDto,
  PanelUserDto,
  PurchasePlansDto,
} from "../api/types";
import {
  clearDeviceSession,
  clearIdentity,
  applySessionSecrets,
  getSession,
  getSessionSecrets,
  markLinkedIdentity,
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
import { pingSubscriptionUrl } from "./subscriptionPinger";

const DEVICE_TYPE = "desktop";
const PLATFORM = "Desktop";
const STARTUP_SESSION_TIMEOUT_MS = 4_500;
const STARTUP_SUBSCRIPTION_TIMEOUT_MS = 4_500;
const TELEGRAM_BOT_NAME = "meow_meow_vpn_bot";

let cachedHostname: string | null = null;

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
    const name = await invoke<string>("get_hostname");
    if (name) {
      cachedHostname = name;
      return name;
    }
  } catch {
    // Tauri command unavailable (e.g. running in browser)
  }
  return "ToBeVPN Desktop";
}

function planForPanelUser(user: PanelUserDto): UserPlan {
  const squads = user.active_internal_squads.map((s) => s.name.toUpperCase());
  if (squads.includes("ADMINS")) return "ADMIN";
  if (squads.includes("STANDART")) return "PAID";
  return "FREE_TRIAL";
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

// --- Public API ---

export async function initializeAuthSession(): Promise<void> {
  const currentSession = getSession();
  const secureSession = await loadSecureSession();

  if (secureSession) {
    if (secureSession.deviceId === currentSession.deviceId) {
      applySessionSecrets(secureSession);
    } else {
      await clearSecureSession();
      applySessionSecrets(null);
    }
  } else {
    const legacySecrets = getSessionSecrets(currentSession);
    if (legacySecrets) {
      await saveSecureSession(legacySecrets);
      applySessionSecrets(legacySecrets);
    }
  }

  await settleStartupStep(
    "syncDeviceSessionState",
    syncDeviceSessionState(),
    STARTUP_SESSION_TIMEOUT_MS,
  );

  if (getSession().isLinked) {
    void settleStartupStep(
      "syncSubscription",
      syncSubscription(),
      STARTUP_SUBSCRIPTION_TIMEOUT_MS,
    );
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

export async function unlinkCurrentDevice(): Promise<void> {
  const { deviceId } = getSession();
  const res = await unlinkDevice({ device_id: deviceId });
  if (!res.success) throw new Error(res.message ?? "Could not unlink device");
}

export interface PairingCode {
  authToken: string;
  qrUrl: string;
}

export async function createPairingCode(): Promise<PairingCode> {
  await syncDeviceSessionState();
  const session = getSession();
  const res = await requestAuth({
    panel_user_uuid: session.panelUserUuid,
  });
  if (!res.success || !res.data) throw new Error(res.message ?? "Empty auth response");

  const authToken = res.data.auth_token;
  const qrUrl = getPairingOpenTargets(authToken).browserUrl;
  return { authToken, qrUrl };
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

  await syncSubscription();
}

/**
 * Refresh subscription info (plan, expiry, traffic) from the panel.
 * No-op for unpaired devices.
 */
export async function syncSubscription(): Promise<void> {
  let session = getSession();
  if (!session.isLinked) return;

  const telegramId = session.telegramId;

  let panelUser: PanelUserDto | null = null;
  if (telegramId !== null) {
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
  }

  const shortUuid = session.shortUuid;
  if (!shortUuid) return;

  let subUser;
  let subscriptionUrl: string | null = null;
  try {
    const subInfo = (await getSubscriptionInfo(shortUuid)).response;
    if (!subInfo.is_found || !subInfo.user) return;
    subUser = subInfo.user;
    subscriptionUrl = subInfo.subscription_url ?? panelUser?.subscription_url ?? null;
  } catch {
    return;
  }

  // Direct hit on the panel's public sub URL with HWID headers — only request
  // panel actually parses for HWID device tracking.
  pingSubscriptionUrl(subscriptionUrl).catch(() => {});

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
  if (!isActive) {
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

  const expiresAtMillis = parseExpiresAtMillis(subUser.expires_at);
  const trafficLimitBytes = Number(subUser.traffic_limit_bytes) || 0;
  const trafficUsedBytes = Number(subUser.traffic_used_bytes) || 0;

  if (import.meta.env.DEV) {
    console.log("[syncSubscription] plan:", plan, "trafficUsed:", trafficUsedBytes, "trafficLimit:", trafficLimitBytes, "raw:", subUser.traffic_used_bytes, "/", subUser.traffic_limit_bytes);
  }

  updateSession({
    userPlan: plan,
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

/**
 * Check whether the current device session is still linked server-side.
 * bootstrap/refresh is the source of truth for remote unlink state.
 */
export async function isCurrentDeviceLinked(): Promise<boolean> {
  const { isLinked } = getSession();
  if (!isLinked) return false;
  try {
    await syncDeviceSessionState();
    return getSession().isLinked;
  } catch {
    return true; // network error → don't kick the user
  }
}

const DEVICE_LINK_POLL_MS = 10_000;
let linkPollTimer: number | null = null;

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
    const linked = await isCurrentDeviceLinked();
    if (!linked) {
      // Tear down the tunnel before clearing identity — otherwise the OS-level
      // VPN keeps routing traffic after the user is bounced to the QR screen,
      // and the next pairing would re-enter Home with the connection still up.
      try {
        await disconnectVpn();
      } catch {
        // ignore — proceed to wipe local state regardless
      }
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
}

export async function logout(): Promise<void> {
  const { isLinked } = getSession();
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
  clearDeviceSession();
}

// --- Pass-through helpers used by screens ---

export async function fetchNodes(): Promise<PanelNodeDto[]> {
  return (await apiGetNodes()).response;
}

export async function fetchDevices(): Promise<LinkedDevicesDto | null> {
  const { isLinked } = getSession();
  if (!isLinked) return null;
  const res = await apiGetDevices();
  if (!res.success || !res.data) return null;
  return res.data;
}

export async function unlinkOtherDevice(deviceId: string): Promise<void> {
  const { isLinked } = getSession();
  if (!isLinked) throw new Error("Not authenticated");
  const res = await unlinkDevice({ device_id: deviceId });
  if (!res.success) throw new Error(res.message ?? "Could not unlink device");
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

function parseVlessUrl(url: string): VpnServer | null {
  if (!url.startsWith("vless://")) return null;
  try {
    const u = new URL(url);
    const uuid = u.username;
    if (!uuid) {
      console.warn("[parseVlessUrl] missing uuid in:", url);
      return null;
    }
    const address = u.hostname;
    if (!address) {
      console.warn("[parseVlessUrl] missing host in:", url);
      return null;
    }
    const port = u.port ? parseInt(u.port, 10) : 443;
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : address;
    const p = u.searchParams;

    return {
      id: uuid,
      name,
      address,
      port,
      uuid,
      flow: p.get("flow") ?? "",
      security: p.get("security") ?? "none",
      sni: p.get("sni") ?? "",
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
  } catch (e) {
    console.warn("[parseVlessUrl] parse error for:", url, e);
    return null;
  }
}

/**
 * Fetch VPN servers from subscription links (VLESS URLs).
 * Mirrors TV's VpnRepository.refreshServers().
 */
export async function fetchVpnServers(): Promise<VpnServer[]> {
  const { shortUuid } = getSession();
  const debug = import.meta.env.DEV;
  if (debug) console.log("[fetchVpnServers] shortUuid:", shortUuid);
  if (!shortUuid) return [];

  const subInfo = (await getSubscriptionInfo(shortUuid)).response;
  if (debug) console.log("[fetchVpnServers] is_found:", subInfo.is_found, "links count:", subInfo.links?.length ?? 0);
  if (!subInfo.is_found || !subInfo.links?.length) return [];

  const servers = subInfo.links
    .map(parseVlessUrl)
    .filter((s): s is VpnServer => s !== null);

  if (debug) console.log("[fetchVpnServers] Parsed servers:", servers.length, "of", subInfo.links.length);

  // Enrich with country from nodes API (mirrors phone's VpnRepository.refreshServers)
  try {
    const nodes = (await apiGetNodes()).response;
    if (debug) console.log("[fetchVpnServers] Nodes count:", nodes.length);
    const countryByAddress = new Map(nodes.map((n) => [n.address, n.country_code]));
    const disabledIps = new Set(
      nodes.filter((n) => n.is_disabled || !n.is_connected).map((n) => n.address),
    );

    await Promise.all(
      servers.map(async (server) => {
        let resolvedIp = server.address;
        try {
          const ip = await invoke<string>("resolve_host", { host: server.address });
          if (ip) resolvedIp = ip;
        } catch {
          // Fallback to raw address
        }
        server.country =
          countryByAddress.get(server.address) ??
          countryByAddress.get(resolvedIp) ??
          "";
        server.isOnline =
          !disabledIps.has(server.address) && !disabledIps.has(resolvedIp);
      }),
    );
  } catch (e) {
    if (debug) console.warn("[fetchVpnServers] nodes enrichment failed:", e);
    // Fallback — keep servers without country info
  }

  return servers;
}

export type { Session };
