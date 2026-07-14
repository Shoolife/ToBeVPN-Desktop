// Singleton update-state store. Mirrors the phone's UpdateViewModel:
// one source of truth shared by UpdateBanner and the Settings "Check for
// updates" row, so dismiss/check/start-download stay in sync across screens.
//
// Persistence:
//   - 7-day cache only for "no update" probes (avoids burning the 60 req/h
//     anonymous rate limit on every cold start; available updates are always
//     revalidated so users never walk through old versions one-by-one)
//   - a pending-update marker. The first launch that discovers a release keeps
//     the existing banner flow; if the update is still pending on the next app
//     launch, it is installed automatically when that preference is enabled
//   - 7-day "dismissed for version X" record so once the user clicks
//     "Позже" the banner stays hidden until that window expires or until
//     a new release ships (automatic installation on the next launch, when
//     enabled, deliberately overrides this visual dismissal). The Settings
//     "Проверить" button also clears it so the banner can re-surface.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t } from "../i18n";

export interface DesktopUpdateInfo {
  version: string;
  notes: string;
  pubDate?: string;
}

export interface DesktopUpdateProgress {
  downloaded: number;
  total: number;
  indeterminate?: boolean;
}

export type DesktopUpdateState =
  | { kind: "idle" }
  | { kind: "available"; info: DesktopUpdateInfo }
  | { kind: "downloading"; info: DesktopUpdateInfo; progress: DesktopUpdateProgress }
  | { kind: "ready"; info: DesktopUpdateInfo }
  | { kind: "failed"; reason: string; info?: DesktopUpdateInfo };

const CACHE_KEY = "tobevpn_update_check_cache_v1";
const DISMISS_KEY = "tobevpn_update_dismiss_v1";
const AUTO_UPDATE_KEY = "tobevpn_auto_update_on_restart_v1";
const PENDING_AUTO_UPDATE_KEY = "tobevpn_pending_auto_update_v1";
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

interface PendingAutoUpdate {
  version: string;
  detectedAt: number;
}

type ProbeResult =
  | { kind: "available"; info: DesktopUpdateInfo }
  | { kind: "current" }
  | { kind: "failed" };

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

/** Automatic installation is opt-out: existing users receive it by default. */
export function getAutoUpdateEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_UPDATE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveAutoUpdateEnabled(enabled: boolean): boolean {
  try {
    localStorage.setItem(AUTO_UPDATE_KEY, enabled ? "1" : "0");
  } catch {
    // Keep the in-memory UI responsive. If storage is unavailable, the safe
    // default (enabled) is restored on the next process launch.
  }
  return enabled;
}

function readCache(): CachedCheck | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCheck;
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    if (parsed.info) {
      clearCache();
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

function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
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

function readPendingAutoUpdate(): PendingAutoUpdate | null {
  try {
    const raw = localStorage.getItem(PENDING_AUTO_UPDATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingAutoUpdate>;
    if (typeof parsed.version !== "string" || parsed.version.trim() === "") return null;
    if (typeof parsed.detectedAt !== "number" || !Number.isFinite(parsed.detectedAt)) return null;
    return { version: parsed.version, detectedAt: parsed.detectedAt };
  } catch {
    return null;
  }
}

function writePendingAutoUpdate(version: string) {
  try {
    localStorage.setItem(
      PENDING_AUTO_UPDATE_KEY,
      JSON.stringify({ version, detectedAt: Date.now() } satisfies PendingAutoUpdate),
    );
  } catch {
    // Without persistent storage the banner/manual flows still work.
  }
}

function clearPendingAutoUpdate() {
  try {
    localStorage.removeItem(PENDING_AUTO_UPDATE_KEY);
  } catch {
    // ignore
  }
}

async function probeNetwork(): Promise<ProbeResult> {
  try {
    const update = await check();
    if (!update) {
      cachedUpdate = null;
      writeCache(null);
      clearPendingAutoUpdate();
      return { kind: "current" };
    }
    cachedUpdate = update;
    const info: DesktopUpdateInfo = {
      version: update.version,
      notes: update.body ?? "",
      pubDate: update.date ?? undefined,
    };
    clearCache();
    writePendingAutoUpdate(info.version);
    return { kind: "available", info };
  } catch (e) {
    console.warn("[updateStore] check failed:", e);
    return { kind: "failed" };
  }
}

/**
 * Idempotent — calling on every banner mount is fine. First call kicks off
 * the cold-start probe, subsequent calls are no-ops.
 */
export async function ensureInitialCheck(): Promise<void> {
  if (probeStarted) return;
  probeStarted = true;

  // Only an update discovered during a previous process run is eligible for
  // automatic installation. A version found right now is offered through the
  // existing top banner first, preserving all three requested update paths.
  const autoInstallPending = getAutoUpdateEnabled() && readPendingAutoUpdate() !== null;

  if (!autoInstallPending) {
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
  }

  const result = await probeNetwork();
  if (result.kind !== "available") return;

  if (autoInstallPending) {
    clearDismiss();
    setState({ kind: "available", info: result.info });
    await startUpdateDownload();
    return;
  }

  const dismissed = readDismiss();
  if (!dismissed || dismissed.version !== result.info.version) {
    setState({ kind: "available", info: result.info });
  }
}

/**
 * Bypasses cache + dismissal. Surfaces the banner again if a newer version
 * is available, or flips to idle if we're up-to-date. Used by Settings'
 * "Проверить обновления" button.
 */
export async function forceCheckUpdate(): Promise<void> {
  if (
    snapshot.manualCheckInFlight ||
    snapshot.state.kind === "downloading" ||
    snapshot.state.kind === "ready"
  ) {
    return;
  }
  setSnapshot({ manualCheckInFlight: true });
  try {
    clearDismiss();
    const result = await probeNetwork();
    if (result.kind === "available") {
      setState({ kind: "available", info: result.info });
    } else if (result.kind === "current") {
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

  if (isLinuxDesktop()) {
    setState({
      kind: "downloading",
      info,
      progress: { downloaded: 0, total: 0, indeterminate: true },
    });
    try {
      await invoke("install_latest_linux_update", { version: info.version });
      clearPendingAutoUpdate();
      clearDismiss();
      setState({ kind: "ready", info });
      await relaunch();
    } catch (e) {
      console.warn("[updateStore] Linux update install failed:", e);
      setState({ kind: "failed", reason: t("update_banner_failed_details"), info });
    }
    return;
  }

  let update = cachedUpdate;
  if (!update) {
    try {
      update = await check();
    } catch (e) {
      console.warn("[updateStore] update re-check failed:", e);
      setState({ kind: "failed", reason: t("update_banner_failed_details"), info });
      return;
    }
  }
  if (!update) {
    setState({ kind: "failed", reason: t("update_banner_failed_details"), info });
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
    clearPendingAutoUpdate();
    clearDismiss();
    setState({ kind: "ready", info });
    await relaunch();
  } catch (e) {
    console.warn("[updateStore] update download/install failed:", e);
    setState({ kind: "failed", reason: t("update_banner_failed_details"), info });
  }
}

function isLinuxDesktop(): boolean {
  return navigator.userAgent.toLowerCase().includes("linux");
}
