// Speed test runs in Rust (src-tauri/src/speed_test.rs), ported from the
// Android client: provider preflight, median ping, warm-up and a 10-second
// download over four parallel streams. This module wraps the commands and
// keeps the local measurement history, as on the phone (up to 100 entries).
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SpeedTestPhase = "idle" | "checking" | "ping" | "download" | "done";

export interface SpeedTestProgress {
  runId: number;
  phase: "checking" | "ping" | "download";
  pingMs: number | null;
  currentMbps: number;
  progress: number;
}

export interface SpeedTestResult {
  runId: number;
  status: "ok" | "cancelled" | "no_connection" | "measure_failed";
  pingMs: number | null;
  downloadMbps: number;
  provider: string | null;
}

export interface SpeedTestHistoryEntry {
  timestampMillis: number;
  downloadMbps: number;
  pingMs: number;
  viaVpn: boolean;
}

const HISTORY_KEY = "tobevpn_speed_test_history_v1";
const MAX_HISTORY_ENTRIES = 100;

let lastRunId = 0;

/** A fresh, strictly increasing, non-zero id for the next run. */
export function nextSpeedTestRunId(): number {
  lastRunId = Math.max(lastRunId + 1, Date.now());
  return lastRunId;
}

export function startSpeedTest(runId: number): Promise<SpeedTestResult> {
  return invoke<SpeedTestResult>("start_speed_test", { runId });
}

export function cancelSpeedTest(): Promise<void> {
  return invoke<void>("cancel_speed_test");
}

export function onSpeedTestProgress(
  handler: (progress: SpeedTestProgress) => void,
): Promise<UnlistenFn> {
  return listen<SpeedTestProgress>("speed-test-progress", (event) => handler(event.payload));
}

function decodeHistory(raw: string | null): SpeedTestHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SpeedTestHistoryEntry =>
        typeof item === "object" && item !== null &&
        Number.isFinite(item.timestampMillis) && item.timestampMillis > 0 &&
        Number.isFinite(item.downloadMbps) && item.downloadMbps > 0 &&
        Number.isFinite(item.pingMs) && item.pingMs >= 0)
      .map((item) => ({
        timestampMillis: item.timestampMillis,
        downloadMbps: item.downloadMbps,
        pingMs: item.pingMs,
        viaVpn: item.viaVpn === true,
      }))
      .sort((a, b) => b.timestampMillis - a.timestampMillis)
      .slice(0, MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

function readHistory(): SpeedTestHistoryEntry[] {
  try {
    return decodeHistory(localStorage.getItem(HISTORY_KEY));
  } catch {
    return [];
  }
}

let history: SpeedTestHistoryEntry[] = readHistory();
const listeners = new Set<() => void>();

function setHistory(next: SpeedTestHistoryEntry[]) {
  history = [...next]
    .sort((a, b) => b.timestampMillis - a.timestampMillis)
    .slice(0, MAX_HISTORY_ENTRIES);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage may be unavailable; the in-memory list still updates.
  }
  for (const listener of listeners) listener();
}

export function addSpeedTestHistoryEntry(entry: SpeedTestHistoryEntry) {
  setHistory([entry, ...history]);
}

export function deleteSpeedTestHistoryEntry(timestampMillis: number) {
  setHistory(history.filter((entry) => entry.timestampMillis !== timestampMillis));
}

export function useSpeedTestHistory(): SpeedTestHistoryEntry[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => history,
  );
}

/** Same colour bands as the phone (25 / 75 / 150 Mbps). */
export function downloadColor(mbps: number): string {
  if (mbps < 25) return "var(--danger)";
  if (mbps < 75) return "var(--warning)";
  if (mbps < 150) return "var(--success)";
  return "var(--info)";
}

export function pingColor(ms: number): string {
  if (ms <= 0) return "var(--text-muted)";
  if (ms <= 100) return "var(--success)";
  if (ms <= 200) return "var(--warning)";
  return "var(--danger)";
}
