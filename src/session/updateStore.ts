// Singleton update-state store. Mirrors the phone's UpdateViewModel:
// one source of truth shared by UpdateBanner and the Settings "Check for
// updates" row, so dismiss/check/start-download stay in sync across screens.
//
// Persistence:
//   - 7-day cache of the GitHub probe result (avoids burning the 60 req/h
//     anonymous rate limit on every cold start; same as phone)
//   - 7-day "dismissed for version X" record so once the user clicks
//     "Позже" the banner stays hidden until that window expires or until
//     a new release ships. The Settings "Проверить" button also clears
//     the dismissal so the banner can re-surface immediately.

import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface DesktopUpdateInfo {
  version: string;
  notes: string;
  pubDate?: string;
}

export interface DesktopUpdateProgress {
  downloaded: number;
  total: number;
}

export type DesktopUpdateState =
  | { kind: "idle" }
  | { kind: "available"; info: DesktopUpdateInfo }
  | { kind: "downloading"; info: DesktopUpdateInfo; progress: DesktopUpdateProgress }
  | { kind: "ready"; info: DesktopUpdateInfo }
  | { kind: "failed"; reason: string; info?: DesktopUpdateInfo };

const CACHE_KEY = "tobevpn_update_check_cache_v1";
const DISMISS_KEY = "tobevpn_update_dismiss_v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedCheck {
  ts: number;
  info: DesktopUpdateInfo | null;
}

interface DismissRecord {
  version: string;
  ts: number;
}

interface Snapshot {
  state: DesktopUpdateState;
  manualCheckInFlight: boolean;
}

let snapshot: Snapshot = { state: { kind: "idle" }, manualCheckInFlight: false };
let cachedUpdate: Update | null = null;
let probeStarted = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function setSnapshot(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  notify();
}

function setState(next: DesktopUpdateState) {
  setSnapshot({ state: next });
}

export function getSnapshot(): Snapshot {
  return snapshot;
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUpdateState(): DesktopUpdateState {
  return useSyncExternalStore(subscribeUpdate, () => snapshot.state);
}

export function useManualCheckInFlight(): boolean {
  return useSyncExternalStore(subscribeUpdate, () => snapshot.manualCheckInFlight);
}

function compareSemver(a: string, b: string): number {
  const parse = (raw: string): number[] => {
    const cleaned = raw.replace(/^v/, "").split(/[-+]/, 1)[0];
    const parts = cleaned.split(".").map((p) => Number(p) || 0);
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function readCache(): CachedCheck | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCheck;
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    // After the user installs an update, __APP_VERSION__ catches up but the
    // cache entry still says "v1.0.1 available". Drop stale "available"
    // rows whose version is <= current so we don't keep nagging the user
    // about a release they've already installed.
    if (parsed.info && compareSemver(parsed.info.version, __APP_VERSION__) <= 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(info: DesktopUpdateInfo | null) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), info } satisfies CachedCheck));
  } catch {
    // ignore quota/private-mode failures
  }
}

function readDismiss(): DismissRecord | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DismissRecord;
    if (Date.now() - parsed.ts > DISMISS_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDismiss(version: string) {
  try {
    localStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ version, ts: Date.now() } satisfies DismissRecord),
    );
  } catch {
    // ignore
  }
}

function clearDismiss() {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    // ignore
  }
}

async function probeNetwork(): Promise<DesktopUpdateInfo | null> {
  try {
    const update = await check();
    if (!update) {
      writeCache(null);
      return null;
    }
    cachedUpdate = update;
    const info: DesktopUpdateInfo = {
      version: update.version,
      notes: update.body ?? "",
      pubDate: update.date ?? undefined,
    };
    writeCache(info);
    return info;
  } catch (e) {
    console.warn("[updateStore] check failed:", e);
    return null;
  }
}

/**
 * Idempotent — calling on every banner mount is fine. First call kicks off
 * the cold-start probe, subsequent calls are no-ops.
 */
export async function ensureInitialCheck(): Promise<void> {
  if (probeStarted) return;
  probeStarted = true;

  const cached = readCache();
  if (cached !== null) {
    if (cached.info) {
      const dismissed = readDismiss();
      if (!dismissed || dismissed.version !== cached.info.version) {
        setState({ kind: "available", info: cached.info });
      }
    }
    return;
  }

  const fresh = await probeNetwork();
  if (fresh) {
    const dismissed = readDismiss();
    if (!dismissed || dismissed.version !== fresh.version) {
      setState({ kind: "available", info: fresh });
    }
  }
}

/**
 * Bypasses cache + dismissal. Surfaces the banner again if a newer version
 * is available, or flips to idle if we're up-to-date. Used by Settings'
 * "Проверить обновления" button.
 */
export async function forceCheckUpdate(): Promise<void> {
  if (snapshot.manualCheckInFlight) return;
  setSnapshot({ manualCheckInFlight: true });
  try {
    clearDismiss();
    const info = await probeNetwork();
    if (info) {
      setState({ kind: "available", info });
    } else if (snapshot.state.kind === "available") {
      // Previously-cached "available" no longer current.
      setState({ kind: "idle" });
    }
  } finally {
    setSnapshot({ manualCheckInFlight: false });
  }
}

export function dismissUpdate(): void {
  const current = snapshot.state;
  if (current.kind === "available") {
    writeDismiss(current.info.version);
  } else if (current.kind === "failed" && current.info) {
    writeDismiss(current.info.version);
  }
  setState({ kind: "idle" });
}

export function retryUpdate(): void {
  const current = snapshot.state;
  if (current.kind === "failed" && current.info) {
    setState({ kind: "available", info: current.info });
  } else {
    void forceCheckUpdate();
  }
}

export async function startUpdateDownload(): Promise<void> {
  const current = snapshot.state;
  if (current.kind !== "available") return;
  const info = current.info;
  setState({ kind: "downloading", info, progress: { downloaded: 0, total: 0 } });

  const update = cachedUpdate ?? (await check());
  if (!update) {
    setState({ kind: "failed", reason: "No update available", info });
    return;
  }

  let downloaded = 0;
  let total = 0;
  // tauri-plugin-updater fires Progress events as fast as the HTTP client
  // hands chunks back — easily 100+/s on a fast pipe. Pushing each one
  // through React re-renders the banner needlessly and causes the bar to
  // visibly stutter when bursts of small chunks arrive together. Coalesce
  // them onto a single rAF tick so we update the UI at most ~60Hz, with
  // the latest cumulative byte count.
  let rafScheduled = false;
  const flushProgress = () => {
    rafScheduled = false;
    if (snapshot.state.kind === "downloading") {
      setState({ kind: "downloading", info, progress: { downloaded, total } });
    }
  };
  const scheduleProgress = () => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(flushProgress);
  };
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          if (snapshot.state.kind === "downloading") {
            setState({ kind: "downloading", info, progress: { downloaded: 0, total } });
          }
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          scheduleProgress();
          break;
        case "Finished":
          downloaded = total > 0 ? total : downloaded;
          if (snapshot.state.kind === "downloading") {
            setState({
              kind: "downloading",
              info,
              progress: { downloaded, total },
            });
          }
          break;
      }
    });
    setState({ kind: "ready", info });
    await relaunch();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    setState({ kind: "failed", reason, info });
  }
}
