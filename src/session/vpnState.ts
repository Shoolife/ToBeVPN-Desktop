// Global VPN runtime state — survives screen navigation and persists traffic.
// Mirrors the phone's @Singleton VpnConnectionManager pattern: a single
// source of truth for connection status, session counters, and the polling
// timer that records traffic deltas into stats storage.
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  startVpn as engineStart,
  stopVpn as engineStop,
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

// Bumps server-side `last_seen_at` every HEARTBEAT_TICKS seconds while VPN is
// connected. /api/device/register is the only client-callable endpoint that
// touches that column — without this the device's "Last active" row in the
// account's device list freezes at the moment of the last app launch.
const HEARTBEAT_TICKS = 60;
const TUNNEL_HEALTH_INITIAL_DELAY_MS = 2_500;
const TUNNEL_HEALTH_INTERVAL_MS = 30_000;
const TUNNEL_HEALTH_RETRY_MS = 3_000;
const TUNNEL_HEALTH_ATTEMPTS = 4;
const TUNNEL_HEALTH_TIMEOUT_MS = 7_000;
const TUNNEL_RECOVERY_RESTART_DELAY_MS = 700;
const MAX_TUNNEL_RECOVERY_ATTEMPTS = 2;
const TUNNEL_PROBE_URL = "https://speed.cloudflare.com/__down?bytes=1";

export interface VpnRuntimeState {
  connected: boolean;
  connecting: boolean;
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
let heartbeatCounter = 0;
let healthTimer: number | null = null;
let connectionGeneration = 0;
let watchdogRecoveryAttempts = 0;
let currentServerForRecovery: ServerVpnConfig | null = null;

function startPolling() {
  if (pollTimer !== null) return;
  heartbeatCounter = 0;
  pollTimer = window.setInterval(async () => {
    let delta = 0;
    try {
      const stats = await getTrafficStats();
      delta = stats.uplink + stats.downlink;
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

    heartbeatCounter++;
    if (heartbeatCounter >= HEARTBEAT_TICKS) {
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
  heartbeatCounter = 0;
}

function isPaidOrAdmin(): boolean {
  const { userPlan } = getSession();
  return userPlan === "PAID" || userPlan === "ADMIN";
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
    setState({ connecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  // Refuse any connect attempt while the user's plan is EXPIRED. The
  // backend's only "server" for an expired user is the sentinel above,
  // and even if some other code path supplies a real server, the panel
  // won't authorize the session — fail fast with a friendly error.
  if (getSession().userPlan === "EXPIRED") {
    const msg = "Subscription expired. Renew it to connect.";
    setState({ connecting: false, connected: false, lastError: msg });
    throw new Error(msg);
  }
  const gen = ++connectionGeneration;
  currentServerForRecovery = server;
  if (resetWatchdogRecovery) {
    watchdogRecoveryAttempts = 0;
  }
  setState({ connecting: true, lastError: null });
  // Limited/trial access depends on the HWID marker being registered before
  // the first outbound connection. Paid/admin users don't need to wait on
  // this best-effort ping, so keep their connect path fast.
  if (isPaidOrAdmin()) {
    pingHwidOnly().catch(() => {});
  } else {
    await pingHwidOnly();
  }
  try {
    await engineStart(server);
    if (gen !== connectionGeneration) {
      await engineStop().catch(() => {});
      return;
    }
    statsSessionStart();
    setState({
      connecting: false,
      connected: true,
      sessionStartTime: Date.now(),
      sessionBytes: 0,
    });
    startPolling();
    startTunnelHealthCheck(gen);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (gen === connectionGeneration) {
      setState({ connecting: false, connected: false, lastError: msg });
    }
    throw e;
  }
}

export async function disconnectVpn(): Promise<void> {
  connectionGeneration++;
  currentServerForRecovery = null;
  stopTunnelHealthCheck();
  stopPolling();
  setState({ connecting: false });
  try {
    await engineStop();
  } finally {
    statsSessionEnd();
    setState({
      connected: false,
      connecting: false,
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
    } else {
      await recoverTunnelAfterHealthFailure(gen);
      return;
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

async function stopVpnWithError(message: string): Promise<void> {
  connectionGeneration++;
  currentServerForRecovery = null;
  stopTunnelHealthCheck();
  stopPolling();
  try {
    await engineStop();
  } finally {
    statsSessionEnd();
    setState({
      connected: false,
      connecting: false,
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
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), TUNNEL_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(TUNNEL_PROBE_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
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
    stopTunnelHealthCheck();
    stopPolling();
    setState({
      connected: false,
      connecting: false,
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
