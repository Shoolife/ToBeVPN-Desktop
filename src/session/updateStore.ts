// Singleton update-state store. Mirrors the phone's UpdateViewModel:
// one source of truth shared by UpdateBanner and the Settings "Check for
// updates" row, so dismiss/check/start-download stay in sync across screens.
//
// Persistence:
//   - when automatic installation is enabled, every new app process checks the
//     network and immediately installs a newer release. This deliberately
//     bypasses the negative cache so a release published after the previous
//     check is not missed on the next launch
//   - the 7-day cache for "no update" probes is used only when automatic
//     installation is disabled (avoids burning the 60 req/h anonymous rate
//     limit while preserving the manual/banner update paths)
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
  phase?: "downloading" | "installing";
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
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 8_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_UPDATE_NOTES_LENGTH = 32 * 1024;

interface CachedCheck {
  ts: number;
  info: DesktopUpdateInfo | null;
}

interface DismissRecord {
  version: string;
  ts: number;
}

type ProbeResult =
  | { kind: "available"; info: DesktopUpdateInfo }
  | { kind: "current" }
  | { kind: "failed" };

export type InitialUpdateCheckResult =
  | "current"
  | "available"
  | "failed"
  | "relaunching";

interface Snapshot {
  state: DesktopUpdateState;
  manualCheckInFlight: boolean;
}

let snapshot: Snapshot = { state: { kind: "idle" }, manualCheckInFlight: false };
let cachedUpdate: Update | null = null;
let initialCheckPromise: Promise<InitialUpdateCheckResult> | null = null;
let operationGeneration = 0;
let autoUpdateEnabledMemory: boolean | null = null;
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
  if (autoUpdateEnabledMemory !== null) return autoUpdateEnabledMemory;
  try {
    autoUpdateEnabledMemory = localStorage.getItem(AUTO_UPDATE_KEY) !== "0";
  } catch {
    autoUpdateEnabledMemory = true;
  }
  return autoUpdateEnabledMemory;
}

export function saveAutoUpdateEnabled(enabled: boolean): boolean {
  autoUpdateEnabledMemory = enabled;
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
    const parsed = JSON.parse(raw) as Partial<CachedCheck>;
    const ts = Number(parsed.ts);
    if (
      !Number.isSafeInteger(ts) ||
      ts <= 0 ||
      ts > Date.now() + 60_000 ||
      Date.now() - ts > CACHE_TTL_MS ||
      (parsed.info !== null && parsed.info !== undefined)
    ) {
      clearCache();
      return null;
    }
    return { ts, info: null };
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
    const parsed = JSON.parse(raw) as Partial<DismissRecord>;
    const version = sanitizeVersion(parsed.version);
    const ts = Number(parsed.ts);
    if (
      !version ||
      !Number.isSafeInteger(ts) ||
      ts <= 0 ||
      ts > Date.now() + 60_000 ||
      Date.now() - ts > DISMISS_TTL_MS
    ) {
      clearDismiss();
      return null;
    }
    return { version, ts };
  } catch {
    clearDismiss();
    return null;
  }
}

function sanitizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed &&
    trimmed.length <= 64 &&
    /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(trimmed)
    ? trimmed
    : null;
}

function updateInfo(update: Update): DesktopUpdateInfo | null {
  const version = sanitizeVersion(update.version);
  if (!version) return null;
  const notes = typeof update.body === "string"
    ? update.body
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .slice(0, MAX_UPDATE_NOTES_LENGTH)
    : "";
  const pubDate = typeof update.date === "string" && update.date.length <= 128
    ? update.date
    : undefined;
  return { version, notes, pubDate };
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

async function probeNetwork(): Promise<ProbeResult> {
  try {
    const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    if (!update) {
      cachedUpdate = null;
      writeCache(null);
      return { kind: "current" };
    }
    cachedUpdate = update;
    const info = updateInfo(update);
    if (!info) {
      cachedUpdate = null;
      return { kind: "failed" };
    }
    clearCache();
    return { kind: "available", info };
  } catch (e) {
    console.warn("[updateStore] check failed:", e);
    return { kind: "failed" };
  }
}

/**
 * Idempotent — every caller awaits the same cold-start flow. Sharing the
 * promise (instead of only a boolean guard) is important for React StrictMode:
 * a remounted startup screen must not continue into the app while the first
 * update check is still running.
 */
export function ensureInitialCheck(): Promise<InitialUpdateCheckResult> {
  if (!initialCheckPromise) {
    initialCheckPromise = runInitialCheck();
  }
  return initialCheckPromise;
}

async function runInitialCheck(): Promise<InitialUpdateCheckResult> {
  const autoInstall = getAutoUpdateEnabled();

  // Automatic mode must always reach the network on a new process launch.
  // Otherwise a cached "no update" result from before a release was published
  // can suppress that release for up to seven days.
  if (!autoInstall) {
    const cached = readCache();
    if (cached !== null) {
      if (cached.info) {
        const dismissed = readDismiss();
        if (!dismissed || dismissed.version !== cached.info.version) {
          setState({ kind: "available", info: cached.info });
        }
      }
      return cached.info ? "available" : "current";
    }
  }

  const result = await probeNetwork();
  if (result.kind === "failed") return "failed";
  if (result.kind === "current") return "current";

  if (autoInstall) {
    clearDismiss();
    setState({ kind: "available", info: result.info });
    await startUpdateDownload();
    return snapshot.state.kind === "failed" ? "failed" : "relaunching";
  }

  const dismissed = readDismiss();
  if (!dismissed || dismissed.version !== result.info.version) {
    setState({ kind: "available", info: result.info });
  }
  return "available";
}

/**
 * A startup failure is shown on the branded launch screen and then cleared
 * without writing a 7-day dismissal. The next process launch may retry the
 * automatic update, while the current launch remains usable.
 */
export function clearStartupUpdateFailure(): void {
  if (snapshot.state.kind === "failed") {
    setState({ kind: "idle" });
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
  const generation = ++operationGeneration;
  setSnapshot({ manualCheckInFlight: true });
  try {
    clearDismiss();
    const result = await probeNetwork();
    const stateKind = getSnapshot().state.kind;
    if (
      generation !== operationGeneration ||
      stateKind === "downloading" ||
      stateKind === "ready"
    ) return;
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
  const generation = ++operationGeneration;
  const info = current.info;
  setState({
    kind: "downloading",
    info,
    progress: { downloaded: 0, total: 0, phase: "downloading" },
  });

  if (isLinuxDesktop()) {
    setState({
      kind: "downloading",
      info,
      progress: { downloaded: 0, total: 0, indeterminate: true, phase: "installing" },
    });
    try {
      await invoke("install_latest_linux_update", { version: info.version });
      if (generation !== operationGeneration) return;
      clearDismiss();
      setState({ kind: "ready", info });
      await relaunch();
    } catch (e) {
      if (generation !== operationGeneration) return;
      console.warn("[updateStore] Linux update install failed:", e);
      setState({ kind: "failed", reason: t("update_banner_failed_details"), info });
    }
    return;
  }

  let update = cachedUpdate;
  if (!update) {
    try {
      update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
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
  const checkedInfo = updateInfo(update);
  if (!checkedInfo) {
    setState({ kind: "failed", reason: t("update_banner_failed_details"), info });
    return;
  }
  if (checkedInfo.version !== info.version) {
    // Require confirmation again if the latest release changed between the
    // check the user saw and the installer re-check.
    cachedUpdate = update;
    setState({ kind: "available", info: checkedInfo });
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
  let downloadFinished = false;
  const flushProgress = () => {
    rafScheduled = false;
    if (
      generation === operationGeneration &&
      snapshot.state.kind === "downloading"
    ) {
      setState({
        kind: "downloading",
        info,
        progress: downloadFinished
          ? { downloaded, total, indeterminate: true, phase: "installing" }
          : { downloaded, total, phase: "downloading" },
      });
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
          if (
            generation === operationGeneration &&
            snapshot.state.kind === "downloading"
          ) {
            setState({
              kind: "downloading",
              info,
              progress: { downloaded: 0, total, phase: "downloading" },
            });
          }
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          scheduleProgress();
          break;
        case "Finished":
          downloadFinished = true;
          downloaded = total > 0 ? total : downloaded;
          if (
            generation === operationGeneration &&
            snapshot.state.kind === "downloading"
          ) {
            setState({
              kind: "downloading",
              info,
              progress: {
                downloaded,
                total,
                indeterminate: true,
                phase: "installing",
              },
            });
          }
          break;
      }
    }, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
    if (generation !== operationGeneration) return;
    clearDismiss();
    setState({ kind: "ready", info });
    await relaunch();
  } catch (e) {
    if (generation !== operationGeneration) return;
    console.warn("[updateStore] update download/install failed:", e);
    setState({ kind: "failed", reason: t("update_banner_failed_details"), info });
  }
}

function isLinuxDesktop(): boolean {
  return navigator.userAgent.toLowerCase().includes("linux");
}
