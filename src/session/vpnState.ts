// Global VPN runtime state — survives screen navigation and persists traffic.
// Mirrors the phone's @Singleton VpnConnectionManager pattern: a single
// source of truth for connection status, session counters, and the polling
// timer that records traffic deltas into stats storage.
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  startVpn as engineStart,
  stopVpn as engineStop,
  getVpnState as engineGetState,
  getTrafficStats,
  type ServerVpnConfig,
} from "./vpn";
import {
  sessionStart as statsSessionStart,
  sessionEnd as statsSessionEnd,
  recordTraffic,
} from "./stats";
import { getSession, subscribeSession } from "./store";
import {
  fetchVpnServers,
  getSubscriptionUsageBlocked,
  isAvailableVpnServer,
  pingHwidOnly,
  registerCurrentDevice,
  type VpnServer,
} from "./auth";
import { t } from "../i18n";
import {
  loadAutomaticServerSelection,
  saveLastServer,
} from "./lastServer";
import { stableServerId } from "./serverSelection";
import {
  recordServerConnectionFailure,
  recordServerConnectionSuccess,
  recordServerTraffic,
  recordServerTunnelFailure,
  recordServerTunnelHealthy,
  selectBestVpnServer,
} from "./serverQuality";
import { recordDiagnosticEvent } from "./diagnostics";

// Poll access blocking frequently while keeping the device `last_seen_at`
// heartbeat at its normal cadence. /api/device/register is the only
// client-callable endpoint that touches the latter column.
const ACCESS_BLOCK_POLL_TICKS = 10;
const DEVICE_HEARTBEAT_TICKS = 60;
const TUNNEL_HEALTH_INITIAL_DELAY_MS = 2_500;
const TUNNEL_HEALTH_INTERVAL_MS = 30_000;
const TUNNEL_HEALTH_RETRY_MS = 3_000;
const TUNNEL_HEALTH_ATTEMPTS = 4;
const TUNNEL_HEALTH_TIMEOUT_MS = 7_000;
const TUNNEL_HEALTH_FAILED_CYCLES_BEFORE_RECOVERY = 2;
const TUNNEL_RECOVERY_RESTART_DELAY_MS = 2_000;
const MANUAL_TUNNEL_RECOVERY_ATTEMPTS = 1;
const AUTOMATIC_TUNNEL_RECOVERY_ATTEMPTS = 2;
const RECENT_TUNNEL_TRAFFIC_GRACE_MS = 60_000;
const QUALITY_TRAFFIC_CONFIRM_BYTES = 64 * 1024;
const NATIVE_CONNECT_TIMEOUT_MS = 45_000;
const TUNNEL_PROBE_URLS = [
  "https://speed.cloudflare.com/__down?bytes=1",
  "https://api.github.com/zen",
] as const;
const SYSTEM_RESUME_GAP_MS = 60_000;
const SYSTEM_RESUME_NETWORK_SETTLE_MS = 3_000;
const SYSTEM_RESUME_ONLINE_WAIT_MS = 15_000;
const SYSTEM_RESUME_ONLINE_POLL_MS = 500;
const SYSTEM_RESUME_HEALTH_ATTEMPTS = 3;
const SYSTEM_RESUME_HEALTH_RETRY_MS = 2_000;
const SYSTEM_RESUME_HEALTH_TIMEOUT_MS = 5_000;
const NETWORK_CHANGE_SETTLE_MS = 1_500;

export interface VpnRuntimeState {
  connected: boolean;
  connecting: boolean;
  disconnecting: boolean;
  /** Epoch ms when the current session started; null when idle. */
  sessionStartTime: number | null;
  /** Bytes transferred since the current session began. */
  sessionBytes: number;
  /** Last connect error, surfaced once and cleared by the consumer. */
  lastError: string | null;
  /** Monotonic tick — bumped each poll so React re-renders the elapsed timer. */
  tick: number;
}

let state: VpnRuntimeState = {
  connected: false,
  connecting: false,
  disconnecting: false,
  sessionStartTime: null,
  sessionBytes: 0,
  lastError: null,
  tick: 0,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<VpnRuntimeState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function getVpnRuntime(): VpnRuntimeState {
  return state;
}

export function getActiveVpnReconnectServer(): ServerVpnConfig | null {
  if (!state.connected && !state.connecting) return null;
  return currentServerForRecovery ? { ...currentServerForRecovery } : null;
}

let pollTimer: number | null = null;
let pollGeneration = 0;
let lastRuntimeTickAt = 0;
// get_traffic_stats can take up to one second on Windows (two bounded Xray
// stats queries). An async setInterval without a gate queues another native
// command before the previous one finishes; after a long lock/sleep those
// queued commands can keep stop_vpn waiting for minutes. There must never be
// more than one traffic poll in flight.
let trafficPollInFlight = false;
let accessBlockCounter = 0;
let accessBlockCheckInFlight = false;
let heartbeatCounter = 0;
let healthTimer: number | null = null;
let connectionGeneration = 0;
let watchdogRecoveryAttempts = 0;
let tunnelHealthFailedCycles = 0;
let lastTunnelTrafficAt: number | null = null;
let currentServerForRecovery: ServerVpnConfig | null = null;
let resumeRecoveryInFlight = false;
let tunnelRecoveryInFlight = false;
let trafficQualityConfirmed = false;
let lastDiagnosticTrafficAt = 0;
let lastStatsDiagnosticFailureAt = 0;
let statsDiagnosticsFailed = false;
let nextTunnelProbeId = 0;

interface ActiveTunnelProbe {
  id: number;
  controllers: Set<AbortController>;
  cancelled: boolean;
  promise: Promise<boolean>;
}

let activeTunnelProbe: ActiveTunnelProbe | null = null;

function toServerVpnConfig(server: Awaited<ReturnType<typeof fetchVpnServers>>[number]): ServerVpnConfig {
  return {
    address: server.address,
    port: server.port,
    uuid: server.uuid,
    flow: server.flow,
    security: server.security,
    sni: server.sni,
    fingerprint: server.fingerprint,
    public_key: server.public_key,
    short_id: server.short_id,
    network: server.network,
    path: server.path,
    mode: server.mode,
    spx: server.spx,
  };
}

function canUseStaleServerConfig(server: ServerVpnConfig): boolean {
  return (
    !getSubscriptionUsageBlocked() &&
    getSession().userPlan !== "EXPIRED" &&
    server.uuid !== "00000000-0000-0000-0000-000000000000" &&
    Boolean(server.address) &&
    server.address !== "127.0.0.1" &&
    server.address !== "0.0.0.0"
  );
}

async function refreshServerConfigAfterAccessCheck(
  server: ServerVpnConfig,
  options: { avoidCurrentInAuto?: boolean; allowStaleOnRefreshError?: boolean } = {},
): Promise<ServerVpnConfig> {
  const canFallbackToStale = () =>
    options.allowStaleOnRefreshError !== false && canUseStaleServerConfig(server);
  let servers: VpnServer[];
  try {
    servers = await fetchVpnServers({ skipAccessPing: true });
  } catch (error) {
    recordDiagnosticEvent(
      "Servers",
      `Server configuration refresh failed; stale fallback ${canFallbackToStale() ? "allowed" : "forbidden"}: ${String(error)}`,
      "W",
    );
    if (canFallbackToStale()) return server;
    throw new Error(t("servers_empty"));
  }
  const availableServers = servers.filter(isAvailableVpnServer);
  recordDiagnosticEvent(
    "Servers",
    `Server configuration refreshed; total=${servers.length}, available=${availableServers.length}`,
  );
  if (availableServers.length === 0) {
    // A successful empty response is authoritative: stale endpoints are only
    // an offline fallback, never a fallback after revocation/removal.
    throw new Error(t("servers_empty"));
  }
  const automatic = loadAutomaticServerSelection();
  const fresh = automatic
    ? await selectBestVpnServer(availableServers, {
        excludeServerId: options.avoidCurrentInAuto ? stableServerId(server) : undefined,
      })
    : availableServers.find(
        (candidate) =>
          candidate.address === server.address &&
          candidate.port === server.port &&
          candidate.sni === (server.sni ?? ""),
      ) ?? null;
  if (!fresh) {
    throw new Error(t("servers_empty"));
  }
  if (automatic) {
    saveLastServer(fresh);
  }
  return toServerVpnConfig(fresh);
}

function startPolling() {
  if (pollTimer !== null) return;
  const generation = ++pollGeneration;
  accessBlockCounter = 0;
  heartbeatCounter = 0;
  lastRuntimeTickAt = Date.now();
  lastStatsDiagnosticFailureAt = 0;
  statsDiagnosticsFailed = false;
  pollTimer = window.setInterval(async () => {
    const now = Date.now();
    const gapMs = now - lastRuntimeTickAt;
    lastRuntimeTickAt = now;
    if (gapMs >= SYSTEM_RESUME_GAP_MS) {
      void recoverTunnelAfterSystemResume(gapMs);
      return;
    }

    if (trafficPollInFlight) return;
    trafficPollInFlight = true;

    let delta = 0;
    try {
      const stats = await getTrafficStats();
      const uplink = Number.isFinite(stats.uplink)
        ? Math.max(0, Math.floor(stats.uplink))
        : 0;
      const downlink = Number.isFinite(stats.downlink)
        ? Math.max(0, Math.floor(stats.downlink))
        : 0;
      delta = Math.min(Number.MAX_SAFE_INTEGER, uplink + downlink);
      if (delta > 0) {
        lastTunnelTrafficAt = now;
        watchdogRecoveryAttempts = 0;
        tunnelHealthFailedCycles = 0;
      }
      if (statsDiagnosticsFailed) {
        statsDiagnosticsFailed = false;
        recordDiagnosticEvent("VPN-Traffic", "Traffic statistics query recovered", "D");
      }
    } catch (error) {
      // Stats API may still be warming up after connect.
      statsDiagnosticsFailed = true;
      if (now - lastStatsDiagnosticFailureAt >= 60_000) {
        lastStatsDiagnosticFailureAt = now;
        recordDiagnosticEvent(
          "VPN-Traffic",
          `Traffic statistics query failed; polling will continue: ${String(error)}`,
          "W",
        );
      }
    } finally {
      trafficPollInFlight = false;
    }
    // A stop/reconnect may have happened while the native stats query was in
    // progress. Never let that obsolete tick mutate the new session.
    if (generation !== pollGeneration) return;
    // Record one tick of session time even when idle, mirroring the phone.
    // Persists into the local stats bucket store (used by StatsScreen).
    // The panel-side trafficUsedBytes is refreshed independently via syncSubscription.
    recordTraffic(delta, 1);
    const nextSessionBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.sessionBytes + delta,
    );
    setState({
      sessionBytes: nextSessionBytes,
      tick: state.tick + 1,
    });
    if (now - lastDiagnosticTrafficAt >= 10_000) {
      lastDiagnosticTrafficAt = now;
      recordDiagnosticEvent(
        "VPN-Traffic",
        `Session traffic sample: transfer_kib_s=${(delta / 1024).toFixed(1)}, session_mib=${(nextSessionBytes / (1024 * 1024)).toFixed(2)}`,
        "D",
      );
    }
    if (
      !trafficQualityConfirmed &&
      nextSessionBytes >= QUALITY_TRAFFIC_CONFIRM_BYTES &&
      currentServerForRecovery
    ) {
      trafficQualityConfirmed = true;
      void recordServerTraffic(currentServerForRecovery, nextSessionBytes);
    }

    if (!accessBlockCheckInFlight) accessBlockCounter++;
    if (!accessBlockCheckInFlight && accessBlockCounter >= ACCESS_BLOCK_POLL_TICKS) {
      accessBlockCounter = 0;
      accessBlockCheckInFlight = true;
      const checkedOwner = getSession().shortUuid;
      try {
        const blocked = await pingHwidOnly().catch(() => false);
        if (
          blocked &&
          checkedOwner === getSession().shortUuid &&
          state.connected
        ) {
          recordDiagnosticEvent("Access", "Server confirmed that VPN access is blocked", "W");
          await stopVpnWithError(t("usage_blocked"));
          return;
        }
      } finally {
        accessBlockCheckInFlight = false;
      }
    }
    heartbeatCounter++;
    if (heartbeatCounter >= DEVICE_HEARTBEAT_TICKS) {
      heartbeatCounter = 0;
      const { isLinked } = getSession();
      if (isLinked) {
        registerCurrentDevice()
          .then(() => recordDiagnosticEvent("Device", "Background device heartbeat completed", "D"))
          .catch((error) => recordDiagnosticEvent(
            "Device",
            `Background device heartbeat failed: ${String(error)}`,
            "W",
          ));
      }
    }
  }, 1000);
}

function stopPolling() {
  pollGeneration++;
  lastRuntimeTickAt = 0;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  accessBlockCounter = 0;
  accessBlockCheckInFlight = false;
  heartbeatCounter = 0;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isTechnicalVpnErrorMessage(message: string): boolean {
  return (
    /"errorCode"\s*:\s*403/i.test(message) ||
    /forbidden:\s*not authorized/i.test(message) ||
    /clienterror/i.test(message) ||
    /fallback route rejected/i.test(message) ||
    /primary route rejected/i.test(message) ||
    /network request failed/i.test(message) ||
    /request timed out/i.test(message) ||
    /not authorized/i.test(message) ||
    /not authenticated/i.test(message) ||
    /http\s*403/i.test(message)
  );
}

function userFacingVpnError(error: unknown, fallback = t("vpn_error_connect")): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.replace(/[\n\r\t]+/g, " ").trim();
  if (!message) return fallback;
  if (/subscription expired/i.test(message)) return t("subscription_expired_connect");
  if (/No IPv4 address found|default IPv4 gateway/i.test(message)) {
    return t("vpn_error_ipv4");
  }
  if (/DNS resolve timed out|DNS resolve failed/i.test(message)) {
    return t("vpn_error_dns");
  }
  if (/timed out after|did not start within|did not appear within|never became ready within/i.test(message)) {
    return t("vpn_error_connect_timeout");
  }
  if (/vpn tunnel stopped|vpn process stopped|xray/i.test(message)) {
    return t("vpn_error_tunnel_stopped");
  }
  if (isTechnicalVpnErrorMessage(message)) return fallback;
  return message.slice(0, 200);
}

async function startNativeVpnWithTimeout(
  server: ServerVpnConfig,
  gen: number,
): Promise<void> {
  let timedOut = false;
  let timeoutId: number | null = null;
  try {
    await Promise.race([
      engineStart(server),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          timedOut = true;
          reject(new Error(t("vpn_error_connect_timeout")));
        }, NATIVE_CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (timedOut && gen === connectionGeneration) {
      await engineStop().catch(() => {});
    }
    throw error;
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

export async function connectVpn(server: ServerVpnConfig): Promise<void> {
  return connectVpnInternal(server, true);
}

async function connectVpnInternal(
  server: ServerVpnConfig,
  resetWatchdogRecovery: boolean,
  avoidCurrentInAuto = false,
  nativeTunnelAlreadyStopped = false,
): Promise<void> {
  // Refuse the panel's "subscription expired" sentinel server before we
  // hand it to the Rust-side engine. xray would crash on its all-zeros
  // uuid / dummy address, taking the whole webview down with it.
  if (
    server.uuid === "00000000-0000-0000-0000-000000000000" ||
    !server.address ||
    server.address === "127.0.0.1" ||
    server.address === "0.0.0.0"
  ) {
    const msg = t("subscription_expired_connect");
    recordDiagnosticEvent(
      "VPN",
      "Connection rejected because the server configuration is unavailable",
      "W",
    );
    setState({ connecting: false, disconnecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  // Refuse any connect attempt while the user's plan is EXPIRED. The
  // backend's only "server" for an expired user is the sentinel above,
  // and even if some other code path supplies a real server, the panel
  // won't authorize the session — fail fast with a friendly error.
  if (getSession().userPlan === "EXPIRED") {
    const msg = t("subscription_expired_connect");
    recordDiagnosticEvent("VPN", "Connection rejected because the subscription is expired", "W");
    setState({ connecting: false, disconnecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  // A manual connect/switch supersedes any background probe. The native
  // start pipeline is already serialized in Rust; cancelling the old fetches
  // here also prevents an obsolete health result from scheduling recovery.
  stopTunnelHealthCheck();
  const cancelInFlightStart =
    state.connecting && !state.connected && !nativeTunnelAlreadyStopped;
  const hadConnectedTunnel = state.connected;
  const previousServerForRecovery = currentServerForRecovery;
  const gen = ++connectionGeneration;
  let serverToStart = server;
  let serverStartAttempted = false;
  let nativeStartCompleted = false;
  currentServerForRecovery = serverToStart;
  if (resetWatchdogRecovery) {
    watchdogRecoveryAttempts = 0;
  }
  setState({ connecting: true, disconnecting: false, lastError: null });
  const connectionStartedAt = performance.now();
  recordDiagnosticEvent(
    "VPN",
    `Connection requested; reconnect=${hadConnectedTunnel}, recovery=${!resetWatchdogRecovery}, routing=${server.routing_mode ?? "default"}`,
  );
  // The subscription response may carry a server-side access block, so this
  // check has to finish before any new tunnel starts.
  try {
    // A server can be changed while the previous native start is still
    // resolving DNS or creating TUN routes. Cancel that obsolete attempt
    // before doing any preparation for the newly selected server.
    if (cancelInFlightStart) {
      recordDiagnosticEvent("VPN", "Cancelling an obsolete native connection attempt", "D");
      await engineStop().catch(() => {});
      if (gen !== connectionGeneration) return;
    }
    // Run the usage-block ping and the server-config refresh concurrently:
    // they hit the panel independently, and overlapping them shaves a full
    // round-trip off every connect/switch. The block check keeps priority —
    // we await it first and, if blocked, surface usage_blocked exactly as
    // before, discarding the refresh (its result/errors are swallowed).
    const blockPing = pingHwidOnly();
    const refresh = refreshServerConfigAfterAccessCheck(serverToStart, {
      avoidCurrentInAuto,
    });
    const preparationStartedAt = performance.now();
    const blocked = await blockPing;
    recordDiagnosticEvent(
      "VPN-Prepare",
      `Access verification completed; blocked=${blocked}, elapsed_ms=${Math.max(0, Math.round(performance.now() - preparationStartedAt))}`,
      blocked ? "W" : "D",
    );
    if (gen !== connectionGeneration) {
      refresh.catch(() => {});
      return;
    }
    if (blocked) {
      refresh.catch(() => {});
      if (hadConnectedTunnel) {
        await engineStop().catch(() => {});
      }
      throw new Error(t("usage_blocked"));
    }
    serverToStart = await refresh;
    recordDiagnosticEvent(
      "VPN-Prepare",
      `Fresh server configuration selected; automatic=${loadAutomaticServerSelection()}, total_elapsed_ms=${Math.max(0, Math.round(performance.now() - preparationStartedAt))}`,
      "D",
    );
    if (gen !== connectionGeneration) return;
    currentServerForRecovery = serverToStart;
    serverStartAttempted = true;
    recordDiagnosticEvent("VPN", "Starting native VPN core and tunnel");
    const nativeStartAt = performance.now();
    await startNativeVpnWithTimeout(serverToStart, gen);
    recordDiagnosticEvent(
      "VPN",
      `Native VPN startup completed; elapsed_ms=${Math.max(0, Math.round(performance.now() - nativeStartAt))}`,
      "D",
    );
    if (gen !== connectionGeneration) return;
    nativeStartCompleted = true;
    // Native start already proves that Xray, tun2socks, Wintun and the routes
    // were created. A public HTTP endpoint is not an authoritative startup
    // gate: WebView/CORS, DNS and a slowly settling Windows route can all make
    // that request fail even though the tunnel itself is usable. Keep traffic
    // validation in the background, as in the stable 1.0.78 connection path.
    if (hadConnectedTunnel) statsSessionEnd();
    statsSessionStart();
    setState({
      connecting: false,
      disconnecting: false,
      connected: true,
      sessionStartTime: Date.now(),
      sessionBytes: 0,
    });
    tunnelHealthFailedCycles = 0;
    lastTunnelTrafficAt = null;
    trafficQualityConfirmed = false;
    void recordServerConnectionSuccess(serverToStart);
    recordDiagnosticEvent(
      "VPN",
      `Native VPN connection established; background traffic validation scheduled; total_elapsed_ms=${Math.max(0, Math.round(performance.now() - connectionStartedAt))}`,
    );
    startPolling();
    startTunnelHealthCheck(gen);
  } catch (e) {
    if (gen !== connectionGeneration) return;
    const msg = userFacingVpnError(e);
    recordDiagnosticEvent(
      "VPN",
      `Connection attempt failed after ${Math.max(0, Math.round(performance.now() - connectionStartedAt))}ms: ${String(e)}`,
      "E",
    );
    if (serverStartAttempted) {
      await recordServerConnectionFailure(serverToStart);
    }
    const nativeState = await engineGetState().catch(() => null);
    const oldTunnelPreserved =
      hadConnectedTunnel &&
      !nativeStartCompleted &&
      nativeState?.status === "Connected";
    if (oldTunnelPreserved) {
      recordDiagnosticEvent(
        "VPN",
        "Previous tunnel remained active after a failed server switch",
        "W",
      );
      currentServerForRecovery = previousServerForRecovery;
      setState({ connecting: false, disconnecting: false, connected: true, lastError: msg });
      startTunnelHealthCheck(gen);
    } else {
      if (nativeStartCompleted) {
        await engineStop().catch(() => {});
      }
      stopTunnelHealthCheck();
      stopPolling();
      if (hadConnectedTunnel) statsSessionEnd();
      currentServerForRecovery = null;
      setState({
        connecting: false,
        disconnecting: false,
        connected: false,
        sessionStartTime: null,
        sessionBytes: 0,
        lastError: msg,
      });
    }
    throw e;
  }
}

export async function disconnectVpn(): Promise<void> {
  if (state.disconnecting) return;
  connectionGeneration++;
  currentServerForRecovery = null;
  resumeRecoveryInFlight = false;
  tunnelHealthFailedCycles = 0;
  lastTunnelTrafficAt = null;
  trafficQualityConfirmed = false;
  stopTunnelHealthCheck();
  stopPolling();
  statsSessionEnd();
  setState({
    connected: false,
    connecting: false,
    disconnecting: true,
    sessionStartTime: null,
    sessionBytes: 0,
  });
  recordDiagnosticEvent("VPN", "User or application requested VPN disconnect");
  try {
    await engineStop();
  } finally {
    setState({
      connected: false,
      connecting: false,
      disconnecting: false,
      sessionStartTime: null,
      sessionBytes: 0,
    });
    recordDiagnosticEvent("VPN", "VPN disconnected and session counters stopped");
  }
}

export async function reconnectVpnWithFreshSubscription(server: ServerVpnConfig): Promise<void> {
  setState({
    connected: false,
    connecting: true,
    disconnecting: false,
    sessionStartTime: null,
    sessionBytes: 0,
    lastError: null,
  });
  try {
    const freshServer = await refreshServerConfigAfterAccessCheck(server, {
      allowStaleOnRefreshError: false,
    });
    await connectVpnInternal(freshServer, true);
  } catch (e) {
    setState({
      connected: false,
      connecting: false,
      disconnecting: false,
      sessionStartTime: null,
      sessionBytes: 0,
      lastError: userFacingVpnError(e),
    });
  }
}

export async function reapplyRoutingSettings(): Promise<void> {
  const server = currentServerForRecovery;
  if (!server || (!state.connected && !state.connecting)) return;
  await connectVpnInternal(server, true);
}

function startTunnelHealthCheck(
  gen: number,
  initialDelayMs = TUNNEL_HEALTH_INITIAL_DELAY_MS,
  source = "PERIODIC",
) {
  stopTunnelHealthCheck();
  healthTimer = window.setTimeout(() => {
    healthTimer = null;
    void runTunnelHealthLoop(gen, source);
  }, initialDelayMs);
}

function stopTunnelHealthCheck() {
  if (healthTimer !== null) {
    clearTimeout(healthTimer);
    healthTimer = null;
  }
  cancelActiveTunnelProbe();
}

async function runTunnelHealthLoop(gen: number, source = "PERIODIC"): Promise<void> {
  if (gen !== connectionGeneration || !state.connected) return;

  // On Windows a due health timeout and the traffic interval are released
  // together after screen unlock. Whichever callback runs first must route
  // through the post-resume validator; otherwise the health callback could
  // start a blind recovery before the interval notices the long timer gap.
  const now = Date.now();
  if (lastRuntimeTickAt > 0 && now - lastRuntimeTickAt >= SYSTEM_RESUME_GAP_MS) {
    const gapMs = now - lastRuntimeTickAt;
    lastRuntimeTickAt = now;
    await recoverTunnelAfterSystemResume(gapMs);
    return;
  }

  if (navigator.onLine !== false) {
    const healthy = await probeTunnelWithRetries(TUNNEL_HEALTH_ATTEMPTS);
    if (gen !== connectionGeneration || !state.connected) return;
    if (healthy === null) {
      recordDiagnosticEvent(
        "VPN-Health",
        `Obsolete tunnel health probe cancelled; source=${source}`,
        "D",
      );
      return;
    }
    if (healthy) {
      if (tunnelHealthFailedCycles > 0 || watchdogRecoveryAttempts > 0) {
        recordDiagnosticEvent("VPN-Health", `Tunnel health recovered; source=${source}`);
      } else {
        recordDiagnosticEvent(
          "VPN-Health",
          `Background tunnel health probe passed; source=${source}`,
          "D",
        );
      }
      watchdogRecoveryAttempts = 0;
      tunnelHealthFailedCycles = 0;
      if (currentServerForRecovery) {
        void recordServerTunnelHealthy(currentServerForRecovery);
      }
    } else if (hasRecentTunnelTraffic()) {
      recordDiagnosticEvent(
        "VPN-Health",
        "Health probe failed but recent tunnel traffic confirms connectivity",
        "W",
      );
      watchdogRecoveryAttempts = 0;
      tunnelHealthFailedCycles = 0;
      if (currentServerForRecovery) {
        void recordServerTunnelHealthy(currentServerForRecovery);
      }
    } else {
      tunnelHealthFailedCycles++;
      recordDiagnosticEvent(
        "VPN-Health",
        `Tunnel health probe failed after all retries; source=${source}, failed_cycle=${tunnelHealthFailedCycles}/${TUNNEL_HEALTH_FAILED_CYCLES_BEFORE_RECOVERY}`,
        "W",
      );
      if (tunnelHealthFailedCycles >= TUNNEL_HEALTH_FAILED_CYCLES_BEFORE_RECOVERY) {
        tunnelHealthFailedCycles = 0;
        if (currentServerForRecovery) {
          await recordServerTunnelFailure(currentServerForRecovery);
        }
        await recoverTunnelAfterHealthFailure(gen);
        return;
      }
    }
  }

  if (gen !== connectionGeneration || !state.connected) return;
  healthTimer = window.setTimeout(() => {
    healthTimer = null;
    void runTunnelHealthLoop(gen, "PERIODIC");
  }, TUNNEL_HEALTH_INTERVAL_MS);
}

async function recoverTunnelAfterHealthFailure(gen: number): Promise<void> {
  if (gen !== connectionGeneration || !state.connected) return;
  if (tunnelRecoveryInFlight) {
    recordDiagnosticEvent(
      "VPN-Recovery",
      "Recovery request coalesced with an active recovery",
      "D",
    );
    return;
  }
  const server = currentServerForRecovery;
  const maxRecoveryAttempts = loadAutomaticServerSelection()
    ? AUTOMATIC_TUNNEL_RECOVERY_ATTEMPTS
    : MANUAL_TUNNEL_RECOVERY_ATTEMPTS;
  if (!server || watchdogRecoveryAttempts >= maxRecoveryAttempts) {
    recordDiagnosticEvent(
      "VPN-Recovery",
      "Automatic tunnel recovery limit reached; stopping VPN",
      "E",
    );
    await stopVpnWithError(t("vpn_error_tunnel_unhealthy"));
    return;
  }

  tunnelRecoveryInFlight = true;
  watchdogRecoveryAttempts++;
  recordDiagnosticEvent(
    "VPN-Recovery",
    `Restarting tunnel after failed health checks; attempt=${watchdogRecoveryAttempts}, max_attempts=${maxRecoveryAttempts}, automatic=${loadAutomaticServerSelection()}`,
    "W",
  );
  stopTunnelHealthCheck();
  stopPolling();
  statsSessionEnd();
  setState({
    connected: false,
    connecting: true,
    disconnecting: false,
    sessionStartTime: null,
    sessionBytes: 0,
    lastError: null,
  });
  try {
    await engineStop().catch(() => {});
    if (gen !== connectionGeneration) return;
    await sleepMs(TUNNEL_RECOVERY_RESTART_DELAY_MS);
    if (gen !== connectionGeneration) return;
    await connectVpnInternal(server, false, true, true).catch(() => {});
  } finally {
    tunnelRecoveryInFlight = false;
  }
}

async function recoverTunnelAfterSystemResume(gapMs: number): Promise<void> {
  if (resumeRecoveryInFlight || tunnelRecoveryInFlight) return;
  const server = currentServerForRecovery;
  // The timer exists for an established session. Never let a delayed tick
  // interfere with a user-initiated connection that is already in progress.
  if (!server || !state.connected) return;

  resumeRecoveryInFlight = true;
  tunnelRecoveryInFlight = true;
  tunnelHealthFailedCycles = 0;
  const gen = ++connectionGeneration;
  console.info(`[VPN] system resume detected after ${Math.round(gapMs / 1000)}s, validating tunnel`);
  recordDiagnosticEvent(
    "VPN-Recovery",
    `System resume detected after ${Math.round(gapMs / 1000)} seconds; validating existing tunnel before recovery`,
    "W",
  );
  stopTunnelHealthCheck();
  stopPolling();

  try {
    const networkAvailable = await waitForNetworkAfterResume();
    if (gen !== connectionGeneration) return;

    if (!networkAvailable) {
      recordDiagnosticEvent(
        "VPN-Recovery",
        "Underlying network is still offline after resume; preserving tunnel and waiting for the online event",
        "W",
      );
      if (state.connected) startPolling();
      return;
    }

    const healthy = await probeTunnelWithRetries(
      SYSTEM_RESUME_HEALTH_ATTEMPTS,
      SYSTEM_RESUME_HEALTH_RETRY_MS,
      SYSTEM_RESUME_HEALTH_TIMEOUT_MS,
    );
    if (gen !== connectionGeneration || healthy === null) return;
    if (healthy) {
      watchdogRecoveryAttempts = 0;
      tunnelHealthFailedCycles = 0;
      recordDiagnosticEvent(
        "VPN-Recovery",
        "Existing tunnel remained healthy after system resume; restart skipped",
      );
      void recordServerTunnelHealthy(server);
      if (state.connected) {
        startPolling();
        startTunnelHealthCheck(gen);
      }
      return;
    }

    recordDiagnosticEvent(
      "VPN-Recovery",
      "Existing tunnel failed post-resume validation; performing one serialized restart",
      "W",
    );
    setState({ connected: false, connecting: true, disconnecting: false, lastError: null });
    await engineStop();
    statsSessionEnd();
    if (gen !== connectionGeneration) return;
    await sleepMs(TUNNEL_RECOVERY_RESTART_DELAY_MS);
    if (gen !== connectionGeneration) return;
    await connectVpnInternal(server, true, false, true);
  } catch (e) {
    const msg = userFacingVpnError(e);
    recordDiagnosticEvent("VPN-Recovery", `Resume recovery failed: ${String(e)}`, "E");
    if (gen === connectionGeneration) {
      setState({ connected: false, connecting: false, disconnecting: false, lastError: msg });
    }
  } finally {
    resumeRecoveryInFlight = false;
    tunnelRecoveryInFlight = false;
  }
}

async function waitForNetworkAfterResume(): Promise<boolean> {
  await sleepMs(SYSTEM_RESUME_NETWORK_SETTLE_MS);
  const startedAt = Date.now();
  while (navigator.onLine === false && Date.now() - startedAt < SYSTEM_RESUME_ONLINE_WAIT_MS) {
    await sleepMs(SYSTEM_RESUME_ONLINE_POLL_MS);
  }
  return navigator.onLine !== false;
}

async function stopVpnWithError(message: string): Promise<void> {
  connectionGeneration++;
  currentServerForRecovery = null;
  resumeRecoveryInFlight = false;
  tunnelHealthFailedCycles = 0;
  lastTunnelTrafficAt = null;
  trafficQualityConfirmed = false;
  stopTunnelHealthCheck();
  stopPolling();
  recordDiagnosticEvent("VPN", `Stopping VPN because of a runtime error: ${message}`, "E");
  try {
    await engineStop();
  } finally {
    statsSessionEnd();
    setState({
      connected: false,
      connecting: false,
      disconnecting: false,
      sessionStartTime: null,
      sessionBytes: 0,
      lastError: message,
    });
  }
}

async function probeTunnelWithRetries(
  attempts: number,
  retryDelayMs = TUNNEL_HEALTH_RETRY_MS,
  attemptTimeoutMs = TUNNEL_HEALTH_TIMEOUT_MS,
): Promise<boolean | null> {
  if (activeTunnelProbe !== null) {
    const probe = activeTunnelProbe;
    recordDiagnosticEvent(
      "VPN-Health",
      `Tunnel probe joined an already active probe; probe_id=${probe.id}`,
      "D",
    );
    const healthy = await probe.promise;
    // Cancellation means this result belongs to an obsolete connection or
    // network state. It must never be counted as a failed health check.
    return probe.cancelled ? null : healthy;
  }

  const probe: ActiveTunnelProbe = {
    id: ++nextTunnelProbeId,
    controllers: new Set(),
    cancelled: false,
    promise: Promise.resolve(false),
  };
  probe.promise = runTunnelProbeAttempts(
    probe,
    attempts,
    retryDelayMs,
    attemptTimeoutMs,
  );
  activeTunnelProbe = probe;
  try {
    const healthy = await probe.promise;
    return probe.cancelled ? null : healthy;
  } finally {
    if (activeTunnelProbe?.id === probe.id) {
      activeTunnelProbe = null;
    }
  }
}

async function runTunnelProbeAttempts(
  probe: ActiveTunnelProbe,
  attempts: number,
  retryDelayMs: number,
  attemptTimeoutMs: number,
): Promise<boolean> {
  const probeStartedAt = performance.now();
  for (let i = 0; i < attempts; i++) {
    if (probe.cancelled) return false;
    const attemptStartedAt = performance.now();
    if (await probeTunnelOnce(probe, attemptTimeoutMs)) {
      recordDiagnosticEvent(
        "VPN-Health",
        `Tunnel probe passed; attempt=${i + 1}/${attempts}, attempt_elapsed_ms=${Math.max(0, Math.round(performance.now() - attemptStartedAt))}, total_elapsed_ms=${Math.max(0, Math.round(performance.now() - probeStartedAt))}`,
        "D",
      );
      return true;
    }
    if (probe.cancelled) return false;
    recordDiagnosticEvent(
      "VPN-Health",
      `Tunnel probe attempt failed; attempt=${i + 1}/${attempts}, elapsed_ms=${Math.max(0, Math.round(performance.now() - attemptStartedAt))}`,
      "D",
    );
    if (i < attempts - 1) await sleepMs(retryDelayMs);
  }
  return false;
}

async function probeTunnelOnce(
  probe: ActiveTunnelProbe,
  timeoutMs: number,
): Promise<boolean> {
  if (probe.cancelled) return false;
  const controllers = TUNNEL_PROBE_URLS.map(() => new AbortController());
  controllers.forEach((controller) => probe.controllers.add(controller));
  const timeoutId = window.setTimeout(() => {
    controllers.forEach((controller) => controller.abort());
  }, timeoutMs);
  try {
    return await new Promise<boolean>((resolve) => {
      let pending = TUNNEL_PROBE_URLS.length;
      let settled = false;

      const finish = (healthy: boolean) => {
        if (settled) return;
        settled = true;
        controllers.forEach((controller) => controller.abort());
        resolve(healthy);
      };

      TUNNEL_PROBE_URLS.forEach((url, index) => {
        fetch(url, {
          cache: "no-store",
          signal: controllers[index].signal,
        })
          // Any HTTP response means routing, DNS and TLS reached the internet.
          .then(() => finish(true))
          .catch(() => {
            pending--;
            if (pending <= 0) finish(false);
          });
      });
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
    controllers.forEach((controller) => probe.controllers.delete(controller));
  }
}

function cancelActiveTunnelProbe() {
  const probe = activeTunnelProbe;
  if (!probe) return;
  activeTunnelProbe = null;
  probe.cancelled = true;
  probe.controllers.forEach((controller) => controller.abort());
  probe.controllers.clear();
}

function hasRecentTunnelTraffic(): boolean {
  return (
    lastTunnelTrafficAt !== null &&
    Date.now() - lastTunnelTrafficAt <= RECENT_TUNNEL_TRAFFIC_GRACE_MS
  );
}

export function clearVpnError() {
  if (state.lastError !== null) setState({ lastError: null });
}

// Listen for the Rust-side watchdog: when xray dies unexpectedly during a
// Connected session, stop polling and surface the error in the UI instead of
// keeping a stale "Connected" badge over a tunnel that's no longer forwarding
// traffic.
let vpnDiedListenerRegistered = false;
function ensureVpnDiedListener() {
  if (vpnDiedListenerRegistered) return;
  vpnDiedListenerRegistered = true;
  listen<string>("vpn-died", (event) => {
    if (event.payload) {
      console.warn("[VPN] process stopped unexpectedly:", event.payload);
    }
    recordDiagnosticEvent(
      "VPN-Watchdog",
      `Native watchdog reported an unexpected process stop: ${event.payload || "no details"}`,
      "E",
    );
    const failedServer = currentServerForRecovery;
    connectionGeneration++;
    currentServerForRecovery = null;
    resumeRecoveryInFlight = false;
    tunnelHealthFailedCycles = 0;
    lastTunnelTrafficAt = null;
    trafficQualityConfirmed = false;
    stopTunnelHealthCheck();
    stopPolling();
    setState({
      connected: false,
      connecting: false,
      disconnecting: false,
      sessionStartTime: null,
      sessionBytes: 0,
      lastError: t("vpn_error_tunnel_stopped"),
    });
    statsSessionEnd();
    if (failedServer) {
      void recordServerTunnelFailure(failedServer);
    }
  }).catch((e) => {
    console.warn("[vpnState] could not register vpn-died listener:", e);
  });
}
ensureVpnDiedListener();

let networkChangeListenersRegistered = false;
function ensureNetworkChangeListeners() {
  if (networkChangeListenersRegistered) return;
  networkChangeListenersRegistered = true;

  const scheduleRecheck = (source: string) => {
    if (!state.connected) return;
    recordDiagnosticEvent(
      "VPN-Health",
      `Underlying network change reported; scheduling one tunnel recheck; source=${source}`,
      "W",
    );
    startTunnelHealthCheck(
      connectionGeneration,
      NETWORK_CHANGE_SETTLE_MS,
      source,
    );
  };

  window.addEventListener("offline", () => {
    if (!state.connected) return;
    recordDiagnosticEvent(
      "VPN-Health",
      "Operating system reported no underlying internet; pausing tunnel probes",
      "W",
    );
    stopTunnelHealthCheck();
  });
  window.addEventListener("online", () => scheduleRecheck("NETWORK_ONLINE"));
}
ensureNetworkChangeListeners();

// Auto-stop the tunnel the moment the user's plan transitions to
// EXPIRED. Without this the green "Connected" badge stays on the
// screen indefinitely (the panel told us we're expired but the local
// xray keeps the tunnel up), and the next user action — picking a
// server — would drag the expired sentinel through the live-switch
// path and crash the engine.
subscribeSession((session) => {
  if (session.userPlan !== "EXPIRED") return;
  if (!state.connected && !state.connecting) return;
  recordDiagnosticEvent(
    "Access",
    "Active VPN is being stopped because the subscription expired",
    "W",
  );
  void disconnectVpn().catch(() => {});
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVpnRuntime(): VpnRuntimeState {
  return useSyncExternalStore(subscribe, getVpnRuntime, getVpnRuntime);
}
