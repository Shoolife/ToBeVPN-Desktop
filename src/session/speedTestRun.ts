import { useSyncExternalStore } from "react";
import { t } from "../i18n";
import { recordDiagnosticEvent } from "./diagnostics";
import {
  addSpeedTestHistoryEntry,
  cancelSpeedTest,
  nextSpeedTestRunId,
  onSpeedTestProgress,
  startSpeedTest,
  type SpeedTestPhase,
} from "./speedTest";

// The running speed test lives outside the screen, like the Android client's
// ViewModel: opening History keeps the measurement going and the screen shows
// its current state on return. Leaving the speed test itself still stops it
// (see stopSpeedTestRun in App's back handler).

export interface SpeedTestRunState {
  phase: SpeedTestPhase;
  ping: number;
  currentSpeed: number;
  download: number;
  error: string | null;
}

const IDLE_STATE: SpeedTestRunState = { phase: "idle", ping: 0, currentSpeed: 0, download: 0, error: null };

let state: SpeedTestRunState = IDLE_STATE;
// Each run has its own id; progress from any other run is ignored, so a late
// event from a cancelled run can never take over the screen.
let activeRunId: number | null = null;
let progressListening = false;
const listeners = new Set<() => void>();

function setState(next: SpeedTestRunState | ((prev: SpeedTestRunState) => SpeedTestRunState)): void {
  state = typeof next === "function" ? next(state) : next;
  listeners.forEach((listener) => listener());
}

function ensureProgressListener(): void {
  if (progressListening) return;
  progressListening = true;
  void onSpeedTestProgress((progress) => {
    if (progress.runId !== activeRunId) return;
    setState((prev) => (prev.phase === "idle" || prev.phase === "done" ? prev : {
      ...prev,
      phase: progress.phase,
      ping: progress.pingMs ?? prev.ping,
      currentSpeed: progress.phase === "download" ? progress.currentMbps : 0,
    }));
  }).catch(() => {
    progressListening = false;
  });
}

export function isSpeedTestRunning(value: SpeedTestRunState = state): boolean {
  return value.phase === "checking" || value.phase === "ping" || value.phase === "download";
}

export async function startSpeedTestRun(viaVpn: boolean): Promise<void> {
  ensureProgressListener();
  const runId = nextSpeedTestRunId();
  activeRunId = runId;
  setState({ ...IDLE_STATE, phase: "checking" });
  recordDiagnosticEvent("SpeedTest", `Manual speed test started; path=${viaVpn ? "vpn" : "direct"}`);
  try {
    const result = await startSpeedTest(runId);
    if (activeRunId !== runId) return;
    activeRunId = null;
    if (result.status === "cancelled") return;
    if (result.status !== "ok" || result.pingMs === null) {
      recordDiagnosticEvent("SpeedTest", `Manual speed test failed: ${result.status}`, "W");
      setState({
        ...IDLE_STATE,
        phase: "done",
        error: t(result.status === "no_connection" ? "speed_no_connection" : "speed_measure_failed"),
      });
      return;
    }
    setState({
      phase: "done",
      ping: result.pingMs,
      currentSpeed: result.downloadMbps,
      download: result.downloadMbps,
      error: null,
    });
    addSpeedTestHistoryEntry({
      timestampMillis: Date.now(),
      downloadMbps: result.downloadMbps,
      pingMs: result.pingMs,
      viaVpn,
    });
    recordDiagnosticEvent(
      "SpeedTest",
      `Manual speed test completed; provider=${result.provider}, ping_ms=${result.pingMs}, ` +
        `download_mbps=${result.downloadMbps.toFixed(2)}, path=${viaVpn ? "vpn" : "direct"}`,
    );
  } catch (error) {
    if (activeRunId !== runId) return;
    activeRunId = null;
    recordDiagnosticEvent("SpeedTest", `Manual speed test failed: ${String(error)}`, "E");
    setState({ ...IDLE_STATE, phase: "done", error: t("speed_measure_failed") });
  }
}

/** Stop button: cancel a running test and return to the idle state. */
export function resetSpeedTestRun(): void {
  const wasRunning = activeRunId !== null;
  activeRunId = null;
  if (wasRunning) {
    void cancelSpeedTest().catch(() => {});
    recordDiagnosticEvent("SpeedTest", "Manual speed test stopped by the user", "W");
  }
  setState(IDLE_STATE);
}

/** Leaving the speed test screen: like closing the phone's screen. */
export function stopSpeedTestRun(): void {
  if (activeRunId !== null) {
    activeRunId = null;
    void cancelSpeedTest().catch(() => {});
  }
  setState(IDLE_STATE);
}

export function useSpeedTestRun(): SpeedTestRunState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
