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
  getUpdateRequired,
  isAvailableVpnServer,
  pingHwidOnly,
  registerCurrentDevice,
  type VpnServer,
} from "./auth";
import { t } from "../i18n";
import { isBrowserPreviewRuntime } from "./browserPreview";
import {
  loadAutomaticServerSelection,
  saveLastServer,
} from "./lastServer";
import type { RoutingSettings } from "./routingSettings";
import { stableServerId } from "./serverSelection";
import { isUpdateInstallInProgress } from "./updateInstallGate";
import {
  recordServerConnectionFailure,
  recordServerConnectionSuccess,
  recordServerTraffic,
  recordServerTunnelFailure,
  recordServerTunnelHealthy,
  selectBestVpnServer,
} from "./serverQuality";

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
const TUNNEL_RECOVERY_RESTART_DELAY_MS = 700;
const MAX_TUNNEL_RECOVERY_ATTEMPTS = 2;
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

export interface VpnRuntimeState {
  connected: boolean;
  connecting: boolean;
  disconnecting: boolean;
  /** Epoch ms when the current session started; null when idle. */
  sessionStartTime: number | null;
  /** Monotonic connected duration; immune to wall-clock/NTP changes. */
  sessionElapsedSeconds: number;
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
  sessionElapsedSeconds: 0,
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
let pollInFlightGeneration: number | null = null;
let accessBlockCounter = 0;
let heartbeatCounter = 0;
let healthTimer: number | null = null;
let connectionGeneration = 0;
let watchdogRecoveryAttempts = 0;
let tunnelHealthFailedCycles = 0;
let lastTunnelTrafficAt: number | null = null;
let currentServerForRecovery: ServerVpnConfig | null = null;
let resumeRecoveryInFlight = false;
let trafficQualityConfirmed = false;
let disconnectInFlight: Promise<void> | null = null;

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
  } catch {
    if (canFallbackToStale()) return server;
    throw new Error(t("servers_empty"));
  }
  const availableServers = servers.filter(isAvailableVpnServer);
  if (availableServers.length === 0) {
    // A successful authoritative empty list means the old endpoint was
    // removed/revoked. Stale fallback is allowed only for a network error.
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
  // performance.now() is monotonic. Date.now() can jump backwards/forwards
  // when Windows synchronizes its clock, which otherwise produces a bogus
  // resume event or suppresses health recovery indefinitely.
  let lastPollAt = performance.now();
  pollTimer = window.setInterval(async () => {
    if (
      generation !== pollGeneration ||
      pollInFlightGeneration === generation
    ) return;
    pollInFlightGeneration = generation;
    const now = performance.now();
    const gapMs = now - lastPollAt;
    lastPollAt = now;

    try {
      if (gapMs >= SYSTEM_RESUME_GAP_MS) {
        void recoverTunnelAfterSystemResume(gapMs);
        return;
      }
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
        }
      } catch {
        // Stats API may still be warming up after connect.
      }
      if (generation !== pollGeneration) return;
      // Use real monotonic elapsed time. Fixed one-second accounting
      // undercounts throttled/background WebViews and overlapping callbacks.
      recordTraffic(delta, Math.max(0, gapMs / 1000));
      const nextSessionBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        state.sessionBytes + delta,
      );
      setState({
        sessionBytes: nextSessionBytes,
        sessionElapsedSeconds: Math.min(
          Number.MAX_SAFE_INTEGER,
          state.sessionElapsedSeconds + Math.max(0, gapMs / 1000),
        ),
        tick: state.tick + 1,
      });
      if (
        !trafficQualityConfirmed &&
        nextSessionBytes >= QUALITY_TRAFFIC_CONFIRM_BYTES &&
        currentServerForRecovery
      ) {
        trafficQualityConfirmed = true;
        void recordServerTraffic(currentServerForRecovery, nextSessionBytes);
      }

      accessBlockCounter++;
      if (accessBlockCounter >= ACCESS_BLOCK_POLL_TICKS) {
        accessBlockCounter = 0;
        const checkedOwner = getSession().shortUuid;
        const blocked = await pingHwidOnly().catch(() => false);
        if (generation !== pollGeneration) return;
        const updateRequired = getUpdateRequired();
        if (
          (blocked || updateRequired) &&
          checkedOwner === getSession().shortUuid &&
          state.connected
        ) {
          await stopVpnWithError(
            blocked ? t("usage_blocked") : t("update_required_message"),
          );
          return;
        }
      }
      heartbeatCounter++;
      if (heartbeatCounter >= DEVICE_HEARTBEAT_TICKS) {
        heartbeatCounter = 0;
        const { isLinked } = getSession();
        if (isLinked) {
          registerCurrentDevice().catch(() => {});
        }
      }
    } catch (error) {
      console.warn("[VPN] polling cycle failed:", error);
    } finally {
      if (pollInFlightGeneration === generation) {
        pollInFlightGeneration = null;
      }
    }
  }, 1000);
}

function stopPolling() {
  pollGeneration++;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  accessBlockCounter = 0;
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
  if (/timed out after|did not start within|did not appear within/i.test(message)) {
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
  routingOverride?: RoutingSettings,
): Promise<void> {
  let timedOut = false;
  let timeoutId: number | null = null;
  try {
    await Promise.race([
      engineStart(server, routingOverride),
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
  // A native stop owns the route/DNS cleanup transaction. Starting while it
  // is still in flight can make that cleanup remove the new tunnel's state.
  if (disconnectInFlight) await disconnectInFlight;
  return connectVpnInternal(server, true);
}

async function connectVpnInternal(
  server: ServerVpnConfig,
  resetWatchdogRecovery: boolean,
  avoidCurrentInAuto = false,
  routingOverride?: RoutingSettings,
): Promise<void> {
  if (isUpdateInstallInProgress()) {
    const message = t("update_banner_installing_privileged");
    setState({ connecting: false, disconnecting: false, lastError: message });
    throw new Error(message);
  }
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
    setState({ connecting: false, disconnecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  // Refuse any connect attempt while the user's plan is EXPIRED. The
  // backend's only "server" for an expired user is the sentinel above,
  // and even if some other code path supplies a real server, the panel
  // won't authorize the session — fail fast with a friendly error.
  if (getSession().userPlan === "EXPIRED") {
    const msg = t("subscription_expired_connect");
    setState({ connecting: false, disconnecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  if (getUpdateRequired()) {
    const msg = t("update_required_message");
    setState({ connecting: false, disconnecting: false, lastError: msg });
    throw new Error(msg);
  }
  const cancelInFlightStart = state.connecting && !state.connected;
  const hadConnectedTunnel = state.connected;
  const previousServerForRecovery = currentServerForRecovery;
  const gen = ++connectionGeneration;
  let serverToStart = server;
  let serverStartAttempted = false;
  currentServerForRecovery = serverToStart;
  if (resetWatchdogRecovery) {
    watchdogRecoveryAttempts = 0;
  }
  setState({ connecting: true, disconnecting: false, lastError: null });
  // The subscription response may carry a server-side access block, so this
  // check has to finish before any new tunnel starts.
  try {
    // A server can be changed while the previous native start is still
    // resolving DNS or creating TUN routes. Cancel that obsolete attempt
    // before doing any preparation for the newly selected server.
    if (cancelInFlightStart) {
      // Starting a second native tunnel after an ambiguous failed cleanup can
      // orphan routes/processes. Propagate the stop failure and let the UI
      // reflect the authoritative native state instead.
      await engineStop();
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
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const blocked = await blockPing;
    if (gen !== connectionGeneration) {
      return;
    }
    if (blocked || getUpdateRequired()) {
      if (hadConnectedTunnel) {
        await engineStop();
      }
      throw new Error(
        blocked ? t("usage_blocked") : t("update_required_message"),
      );
    }
    const refreshResult = await refresh;
    if (!refreshResult.ok) throw refreshResult.error;
    serverToStart = refreshResult.value;
    if (gen !== connectionGeneration) return;
    currentServerForRecovery = serverToStart;
    serverStartAttempted = true;
    await startNativeVpnWithTimeout(serverToStart, gen, routingOverride);
    if (gen !== connectionGeneration) return;
    if (hadConnectedTunnel) statsSessionEnd();
    statsSessionStart();
    setState({
      connecting: false,
      disconnecting: false,
      connected: true,
      sessionStartTime: Date.now(),
      sessionElapsedSeconds: 0,
      sessionBytes: 0,
    });
    tunnelHealthFailedCycles = 0;
    lastTunnelTrafficAt = null;
    trafficQualityConfirmed = false;
    void recordServerConnectionSuccess(serverToStart);
    startPolling();
    startTunnelHealthCheck(gen);
  } catch (e) {
    const msg = userFacingVpnError(e);
    if (gen === connectionGeneration) {
      if (serverStartAttempted) {
        await recordServerConnectionFailure(serverToStart);
      }
      const nativeState = await engineGetState().catch(() => null);
      const nativeConnected = nativeState?.status === "Connected";
      const cleanupMayRemain =
        nativeState?.status !== "Disconnected" &&
        (hadConnectedTunnel || serverStartAttempted);
      if (nativeConnected || cleanupMayRemain) {
        currentServerForRecovery = hadConnectedTunnel
          ? previousServerForRecovery
          : serverToStart;
        if (nativeConnected && !hadConnectedTunnel) statsSessionStart();
        setState({
          connecting: false,
          disconnecting: false,
          connected: true,
          sessionStartTime:
            state.sessionStartTime ?? (nativeConnected ? Date.now() : null),
          lastError: msg,
        });
        if (nativeConnected) {
          startPolling();
          startTunnelHealthCheck(gen);
        } else {
          stopPolling();
          stopTunnelHealthCheck();
        }
      } else {
        currentServerForRecovery = null;
        stopTunnelHealthCheck();
        stopPolling();
        if (hadConnectedTunnel) statsSessionEnd();
        setState({ connecting: false, disconnecting: false, connected: false, lastError: msg });
      }
    }
    throw e;
  }
}

export function disconnectVpn(): Promise<void> {
  if (disconnectInFlight) return disconnectInFlight;
  const promise = disconnectVpnInternal().finally(() => {
    if (disconnectInFlight === promise) disconnectInFlight = null;
  });
  disconnectInFlight = promise;
  return promise;
}

async function disconnectVpnInternal(): Promise<void> {
  const gen = ++connectionGeneration;
  const serverBeforeStop = currentServerForRecovery;
  resumeRecoveryInFlight = false;
  tunnelHealthFailedCycles = 0;
  lastTunnelTrafficAt = null;
  trafficQualityConfirmed = false;
  stopTunnelHealthCheck();
  stopPolling();
  setState({
    connected: state.connected,
    connecting: false,
    disconnecting: true,
  });
  try {
    await engineStop();
    currentServerForRecovery = null;
    statsSessionEnd();
    setState({
      connected: false,
      connecting: false,
      disconnecting: false,
      sessionStartTime: null,
      sessionElapsedSeconds: 0,
      sessionBytes: 0,
    });
  } catch (error) {
    const nativeState = await engineGetState().catch(() => null);
    if (nativeState?.status === "Disconnected") {
      // The stop IPC may fail after cleanup has already committed. Native
      // state is authoritative, so treat this as a successful disconnect.
      currentServerForRecovery = null;
      statsSessionEnd();
      setState({
        connected: false,
        connecting: false,
        disconnecting: false,
        sessionStartTime: null,
        sessionElapsedSeconds: 0,
        sessionBytes: 0,
      });
      return;
    }
    // Every non-Disconnected/unknown result is ambiguous: keep credentials
    // and recovery context so another Stop attempt can finish cleanup.
    const cleanupIncomplete = true;
    currentServerForRecovery = serverBeforeStop;
    if (nativeState?.status === "Connected") {
      startPolling();
      startTunnelHealthCheck(gen);
    }
    setState({
      connected: cleanupIncomplete,
      connecting: false,
      disconnecting: false,
      lastError: userFacingVpnError(error, t("vpn_error_tunnel_stopped")),
    });
    throw error;
  }
}

export function getVpnConnectionGeneration(): number {
  return connectionGeneration;
}

export async function reconnectVpnWithFreshSubscription(
  server: ServerVpnConfig,
  expectedGeneration = connectionGeneration,
): Promise<void> {
  if (expectedGeneration !== connectionGeneration) return;
  setState({
    connected: false,
    connecting: true,
    disconnecting: false,
    sessionStartTime: null,
    sessionElapsedSeconds: 0,
    sessionBytes: 0,
    lastError: null,
  });
  try {
    const freshServer = await refreshServerConfigAfterAccessCheck(server, {
      allowStaleOnRefreshError: false,
    });
    if (expectedGeneration !== connectionGeneration) return;
    await connectVpnInternal(freshServer, true);
  } catch (e) {
    // connectVpnInternal owns its own generation and error state. Only a
    // refresh failure that belongs to this still-current intent is handled
    // here; a user pressing Stop invalidates expectedGeneration immediately.
    if (expectedGeneration === connectionGeneration) {
      setState({
        connected: false,
        connecting: false,
        disconnecting: false,
        sessionStartTime: null,
        sessionElapsedSeconds: 0,
        sessionBytes: 0,
        lastError: userFacingVpnError(e),
      });
    }
  }
}

export async function reapplyRoutingSettings(
  routingSettings?: RoutingSettings,
  rollbackSettings?: RoutingSettings,
): Promise<void> {
  const server = currentServerForRecovery;
  if (!server || (!state.connected && !state.connecting)) return;
  try {
    await connectVpnInternal(server, true, false, routingSettings);
  } catch (error) {
    // If native startup already tore the previous tunnel down, restore the
    // last known-good routing profile before surfacing the apply failure.
    if (rollbackSettings && !state.connected && !state.connecting) {
      await connectVpnInternal(server, true, false, rollbackSettings).catch(
        (rollbackError) => {
          console.warn("[VPN] routing rollback failed:", rollbackError);
        },
      );
    }
    throw error;
  }
}

function startTunnelHealthCheck(gen: number) {
  stopTunnelHealthCheck();
  healthTimer = window.setTimeout(() => {
    void runTunnelHealthLoop(gen);
  }, TUNNEL_HEALTH_INITIAL_DELAY_MS);
}

function stopTunnelHealthCheck() {
  if (healthTimer !== null) {
    clearTimeout(healthTimer);
    healthTimer = null;
  }
}

async function runTunnelHealthLoop(gen: number): Promise<void> {
  if (gen !== connectionGeneration || !state.connected) return;

  if (navigator.onLine === false) {
    healthTimer = window.setTimeout(() => {
      void runTunnelHealthLoop(gen);
    }, TUNNEL_HEALTH_RETRY_MS);
    return;
  }

  {
    const healthy = await probeTunnelWithRetries(TUNNEL_HEALTH_ATTEMPTS);
    if (gen !== connectionGeneration || !state.connected) return;
    if (healthy) {
      watchdogRecoveryAttempts = 0;
      tunnelHealthFailedCycles = 0;
      if (currentServerForRecovery) {
        void recordServerTunnelHealthy(currentServerForRecovery);
      }
    } else if (hasRecentTunnelTraffic()) {
      tunnelHealthFailedCycles = 0;
      if (currentServerForRecovery) {
        void recordServerTunnelHealthy(currentServerForRecovery);
      }
    } else {
      tunnelHealthFailedCycles++;
      if (tunnelHealthFailedCycles < TUNNEL_HEALTH_FAILED_CYCLES_BEFORE_RECOVERY) {
        console.warn("[VPN] tunnel health probe failed; waiting for a second failed cycle");
      } else {
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
    void runTunnelHealthLoop(gen);
  }, TUNNEL_HEALTH_INTERVAL_MS);
}

async function recoverTunnelAfterHealthFailure(gen: number): Promise<void> {
  if (gen !== connectionGeneration || !state.connected) return;
  const server = currentServerForRecovery;
  if (!server || watchdogRecoveryAttempts >= MAX_TUNNEL_RECOVERY_ATTEMPTS) {
    await stopVpnWithError(t("vpn_error_tunnel_stopped"));
    return;
  }

  watchdogRecoveryAttempts++;
  try {
    await disconnectVpn();
  } catch {
    return;
  }
  const restartGeneration = connectionGeneration;
  await sleepMs(TUNNEL_RECOVERY_RESTART_DELAY_MS);
  if (
    restartGeneration === connectionGeneration &&
    !state.connected &&
    !state.connecting
  ) {
    await connectVpnInternal(server, false, true).catch(() => {});
  }
}

async function recoverTunnelAfterSystemResume(gapMs: number): Promise<void> {
  if (resumeRecoveryInFlight) return;
  const server = currentServerForRecovery;
  if (!server || (!state.connected && !state.connecting)) return;

  resumeRecoveryInFlight = true;
  tunnelHealthFailedCycles = 0;
  const gen = ++connectionGeneration;
  console.info(`[VPN] system resume detected after ${Math.round(gapMs / 1000)}s, restarting tunnel`);
  stopTunnelHealthCheck();
  stopPolling();
  setState({ connected: false, connecting: true, disconnecting: false, lastError: null });

  try {
    await engineStop();
    statsSessionEnd();
    await waitForNetworkAfterResume();
    if (gen !== connectionGeneration) return;
    await connectVpnInternal(server, true);
  } catch (e) {
    const msg = userFacingVpnError(e);
    if (gen === connectionGeneration) {
      const nativeState = await engineGetState().catch(() => null);
      const cleanupIncomplete = nativeState?.status !== "Disconnected";
      if (!cleanupIncomplete) {
        currentServerForRecovery = null;
        statsSessionEnd();
      }
      setState({
        connected: cleanupIncomplete,
        connecting: false,
        disconnecting: false,
        lastError: msg,
      });
      if (nativeState?.status === "Connected") {
        startPolling();
        startTunnelHealthCheck(gen);
      }
    }
  } finally {
    resumeRecoveryInFlight = false;
  }
}

async function waitForNetworkAfterResume(): Promise<void> {
  await sleepMs(SYSTEM_RESUME_NETWORK_SETTLE_MS);
  const startedAt = performance.now();
  while (
    navigator.onLine === false &&
    performance.now() - startedAt < SYSTEM_RESUME_ONLINE_WAIT_MS
  ) {
    await sleepMs(SYSTEM_RESUME_ONLINE_POLL_MS);
  }
}

async function stopVpnWithError(message: string): Promise<void> {
  try {
    await disconnectVpn();
    setState({ lastError: message });
  } catch (error) {
    setState({
      lastError: `${message}: ${userFacingVpnError(error, t("vpn_error_tunnel_stopped"))}`,
    });
  }
}

async function probeTunnelWithRetries(attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeTunnelOnce()) return true;
    if (i < attempts - 1) await sleepMs(TUNNEL_HEALTH_RETRY_MS);
  }
  return false;
}

async function probeTunnelOnce(): Promise<boolean> {
  const controllers = TUNNEL_PROBE_URLS.map(() => new AbortController());
  const timeoutId = window.setTimeout(() => {
    controllers.forEach((controller) => controller.abort());
  }, TUNNEL_HEALTH_TIMEOUT_MS);
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
  }
}

function hasRecentTunnelTraffic(): boolean {
  const age =
    lastTunnelTrafficAt === null
      ? Number.POSITIVE_INFINITY
      : performance.now() - lastTunnelTrafficAt;
  return (
    age >= 0 &&
    age <= RECENT_TUNNEL_TRAFFIC_GRACE_MS
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
let vpnDiedListenerRetries = 0;
let vpnDiedListenerRetryTimer: number | null = null;
function ensureVpnDiedListener() {
  if (vpnDiedListenerRegistered || isBrowserPreviewRuntime()) return;
  vpnDiedListenerRegistered = true;
  listen<string>("vpn-died", (event) => {
    if (event.payload) {
      console.warn("[VPN] process stopped unexpectedly:", event.payload);
    }
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
      sessionElapsedSeconds: 0,
      sessionBytes: 0,
      lastError: t("vpn_error_tunnel_stopped"),
    });
    statsSessionEnd();
    if (failedServer) {
      void recordServerTunnelFailure(failedServer);
    }
  }).then(() => {
    vpnDiedListenerRetries = 0;
    if (vpnDiedListenerRetryTimer !== null) {
      clearTimeout(vpnDiedListenerRetryTimer);
      vpnDiedListenerRetryTimer = null;
    }
  }).catch((e) => {
    vpnDiedListenerRegistered = false;
    console.warn("[vpnState] could not register vpn-died listener:", e);
    if (vpnDiedListenerRetries >= 3 || vpnDiedListenerRetryTimer !== null) return;
    vpnDiedListenerRetries += 1;
    vpnDiedListenerRetryTimer = window.setTimeout(() => {
      vpnDiedListenerRetryTimer = null;
      ensureVpnDiedListener();
    }, 1_000);
  });
}
ensureVpnDiedListener();

// Auto-stop the tunnel the moment the user's plan expires or any token/API
// path reports that this device is no longer linked. Without this the UI can
// navigate to pairing while an OS-level tunnel remains active with no Stop
// control available on that screen.
subscribeSession((session) => {
  if (session.isLinked && session.userPlan !== "EXPIRED") return;
  if (!state.connected && !state.connecting) return;
  void disconnectVpn().catch(() => {});
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVpnRuntime(): VpnRuntimeState {
  return useSyncExternalStore(subscribe, getVpnRuntime, getVpnRuntime);
}
