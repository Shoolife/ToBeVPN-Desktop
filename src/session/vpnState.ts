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
import { pingHwidOnly, registerCurrentDevice } from "./auth";
import { t } from "../i18n";

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

let pollTimer: number | null = null;
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

function startPolling() {
  if (pollTimer !== null) return;
  accessBlockCounter = 0;
  heartbeatCounter = 0;
  let lastPollAt = Date.now();
  pollTimer = window.setInterval(async () => {
    const now = Date.now();
    const gapMs = now - lastPollAt;
    lastPollAt = now;
    if (gapMs >= SYSTEM_RESUME_GAP_MS) {
      void recoverTunnelAfterSystemResume(gapMs);
      return;
    }

    let delta = 0;
    try {
      const stats = await getTrafficStats();
      delta = stats.uplink + stats.downlink;
      if (delta > 0) {
        lastTunnelTrafficAt = now;
      }
    } catch {
      // Stats API may still be warming up after connect.
    }
    // Record one tick of session time even when idle, mirroring the phone.
    // Persists into the local stats bucket store (used by StatsScreen).
    // The panel-side trafficUsedBytes is refreshed independently via syncSubscription.
    recordTraffic(delta, 1);
    setState({
      sessionBytes: state.sessionBytes + delta,
      tick: state.tick + 1,
    });

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
        registerCurrentDevice().catch(() => {});
      }
    }
  }, 1000);
}

function stopPolling() {
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

export async function connectVpn(server: ServerVpnConfig): Promise<void> {
  return connectVpnInternal(server, true);
}

async function connectVpnInternal(
  server: ServerVpnConfig,
  resetWatchdogRecovery: boolean,
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
    const msg = "Subscription expired. Renew it to connect.";
    setState({ connecting: false, disconnecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  // Refuse any connect attempt while the user's plan is EXPIRED. The
  // backend's only "server" for an expired user is the sentinel above,
  // and even if some other code path supplies a real server, the panel
  // won't authorize the session — fail fast with a friendly error.
  if (getSession().userPlan === "EXPIRED") {
    const msg = "Subscription expired. Renew it to connect.";
    setState({ connecting: false, disconnecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  const cancelInFlightStart = state.connecting && !state.connected;
  const hadConnectedTunnel = state.connected;
  const previousServerForRecovery = currentServerForRecovery;
  const gen = ++connectionGeneration;
  currentServerForRecovery = server;
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
      await engineStop().catch(() => {});
      if (gen !== connectionGeneration) return;
    }
    if (await pingHwidOnly()) {
      if (hadConnectedTunnel) {
        await engineStop().catch(() => {});
      }
      throw new Error(t("usage_blocked"));
    }
    if (gen !== connectionGeneration) return;
    await engineStart(server);
    if (gen !== connectionGeneration) return;
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
    startPolling();
    startTunnelHealthCheck(gen);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (gen === connectionGeneration) {
      const nativeState = await engineGetState().catch(() => null);
      const oldTunnelPreserved =
        hadConnectedTunnel && nativeState?.status === "Connected";
      if (oldTunnelPreserved) {
        currentServerForRecovery = previousServerForRecovery;
        setState({ connecting: false, disconnecting: false, connected: true, lastError: msg });
        startTunnelHealthCheck(gen);
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

export async function disconnectVpn(): Promise<void> {
  if (state.disconnecting) return;
  connectionGeneration++;
  currentServerForRecovery = null;
  resumeRecoveryInFlight = false;
  tunnelHealthFailedCycles = 0;
  lastTunnelTrafficAt = null;
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

  if (navigator.onLine !== false) {
    const healthy = await probeTunnelWithRetries(TUNNEL_HEALTH_ATTEMPTS);
    if (gen !== connectionGeneration || !state.connected) return;
    if (healthy) {
      watchdogRecoveryAttempts = 0;
      tunnelHealthFailedCycles = 0;
    } else if (hasRecentTunnelTraffic()) {
      tunnelHealthFailedCycles = 0;
    } else {
      tunnelHealthFailedCycles++;
      if (tunnelHealthFailedCycles < TUNNEL_HEALTH_FAILED_CYCLES_BEFORE_RECOVERY) {
        console.warn("[VPN] tunnel health probe failed; waiting for a second failed cycle");
      } else {
        tunnelHealthFailedCycles = 0;
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
    await stopVpnWithError("VPN tunnel stopped forwarding traffic");
    return;
  }

  watchdogRecoveryAttempts++;
  await disconnectVpn().catch(() => {});
  await sleepMs(TUNNEL_RECOVERY_RESTART_DELAY_MS);
  if (!state.connected && !state.connecting) {
    await connectVpnInternal(server, false).catch(() => {});
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
    await engineStop().catch((e) => {
      console.warn("[VPN] resume cleanup failed before reconnect:", e);
    });
    statsSessionEnd();
    await waitForNetworkAfterResume();
    if (gen !== connectionGeneration) return;
    await connectVpnInternal(server, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (gen === connectionGeneration) {
      setState({ connected: false, connecting: false, disconnecting: false, lastError: msg });
    }
  } finally {
    resumeRecoveryInFlight = false;
  }
}

async function waitForNetworkAfterResume(): Promise<void> {
  await sleepMs(SYSTEM_RESUME_NETWORK_SETTLE_MS);
  const startedAt = Date.now();
  while (navigator.onLine === false && Date.now() - startedAt < SYSTEM_RESUME_ONLINE_WAIT_MS) {
    await sleepMs(SYSTEM_RESUME_ONLINE_POLL_MS);
  }
}

async function stopVpnWithError(message: string): Promise<void> {
  connectionGeneration++;
  currentServerForRecovery = null;
  resumeRecoveryInFlight = false;
  tunnelHealthFailedCycles = 0;
  lastTunnelTrafficAt = null;
  stopTunnelHealthCheck();
  stopPolling();
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
    connectionGeneration++;
    currentServerForRecovery = null;
    resumeRecoveryInFlight = false;
    tunnelHealthFailedCycles = 0;
    lastTunnelTrafficAt = null;
    stopTunnelHealthCheck();
    stopPolling();
    setState({
      connected: false,
      connecting: false,
      disconnecting: false,
      sessionStartTime: null,
      sessionBytes: 0,
      lastError: event.payload || "VPN process stopped unexpectedly",
    });
    statsSessionEnd();
  }).catch((e) => {
    console.warn("[vpnState] could not register vpn-died listener:", e);
  });
}
ensureVpnDiedListener();

// Auto-stop the tunnel the moment the user's plan transitions to
// EXPIRED. Without this the green "Connected" badge stays on the
// screen indefinitely (the panel told us we're expired but the local
// xray keeps the tunnel up), and the next user action — picking a
// server — would drag the expired sentinel through the live-switch
// path and crash the engine.
subscribeSession((session) => {
  if (session.userPlan !== "EXPIRED") return;
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
