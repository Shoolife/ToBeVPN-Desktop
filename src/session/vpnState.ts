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
import { getSession } from "./store";
import { registerCurrentDevice, syncSubscription } from "./auth";

// Bumps server-side `last_seen_at` every HEARTBEAT_TICKS seconds while VPN is
// connected. /api/device/register is the only client-callable endpoint that
// touches that column — without this the device's "Last active" row in the
// account's device list freezes at the moment of the last app launch.
const HEARTBEAT_TICKS = 60;

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

export async function connectVpn(server: ServerVpnConfig): Promise<void> {
  setState({ connecting: true, lastError: null });
  // Fire-and-forget: hits the panel's public sub URL with HWID headers so
  // panel registers/refreshes the HWID device on every connect.
  syncSubscription().catch(() => {});
  try {
    await engineStart(server);
    statsSessionStart();
    setState({
      connecting: false,
      connected: true,
      sessionStartTime: Date.now(),
      sessionBytes: 0,
    });
    startPolling();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setState({ connecting: false, connected: false, lastError: msg });
    throw e;
  }
}

export async function disconnectVpn(): Promise<void> {
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVpnRuntime(): VpnRuntimeState {
  return useSyncExternalStore(subscribe, getVpnRuntime, getVpnRuntime);
}
