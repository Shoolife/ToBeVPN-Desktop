// Thin wrapper around tauri-plugin-updater so the rest of the app can call
// "is there an update?" / "apply it" without learning the plugin's API.
//
// Flow:
//   checkForUpdate() → null if up-to-date, otherwise descriptor with version
//   downloadAndInstall() → downloads, verifies ed25519 signature, runs the
//                         platform installer (dpkg/NSIS), then relaunches.
//
// The pubkey is baked into tauri.conf.json. Anyone who tampers with the
// release manifest or the bundle file will fail signature verification and
// the install is rejected — that's why we don't add SHA256 checks here, the
// plugin already does the equivalent and stronger.
//
// Caching: GitHub's unauthenticated API is rate-limited at 60 req/h per IP.
// To avoid burning that budget on every cold start (especially for users
// behind shared/carrier-grade NATs) we cache the result for 7 days. The user
// can manually skip the cache via the "Check for updates" button in Settings.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface DesktopUpdateInfo {
  version: string;
  notes: string;
  pubDate?: string;
}

export interface DesktopUpdateProgress {
  /** Bytes downloaded so far. */
  downloaded: number;
  /** Total bytes; 0 when the server didn't send Content-Length. */
  total: number;
}

export type DesktopUpdateState =
  | { kind: "idle" }
  | { kind: "available"; info: DesktopUpdateInfo }
  | { kind: "downloading"; info: DesktopUpdateInfo; progress: DesktopUpdateProgress }
  | { kind: "ready"; info: DesktopUpdateInfo }
  | { kind: "failed"; reason: string };

let cachedUpdate: Update | null = null;

const CACHE_KEY = "tobevpn_update_check_cache_v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedCheck {
  ts: number;
  /** null when last probe found we're up-to-date. */
  info: DesktopUpdateInfo | null;
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

/**
 * Returns -1, 0 or 1 for left vs right semver comparison. Tolerant of "v"
 * prefix and pre-release suffixes (treats "1.2.3-rc1" as 1.2.3).
 */
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

function writeCache(info: DesktopUpdateInfo | null) {
  try {
    const payload: CachedCheck = { ts: Date.now(), info };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

/**
 * Returns the available update (or null if up-to-date).
 *
 * @param force when true, bypasses the 7-day cache and hits GitHub directly.
 *              Used by the "Check for updates" button in Settings.
 */
export async function checkForUpdate(
  force = false,
): Promise<DesktopUpdateInfo | null> {
  if (!force) {
    const cached = readCache();
    if (cached) return cached.info;
  }
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
    console.warn("[desktopUpdater] check failed:", e);
    return null;
  }
}

/**
 * Streams the bundle from the GitHub release, verifies signature, runs the
 * platform-specific installer. On success the OS hands control back here and
 * we restart the app to land on the new version.
 *
 * onProgress is invoked for every byte chunk DownloadEvent the plugin emits.
 */
export async function downloadAndInstall(
  onProgress: (p: DesktopUpdateProgress) => void,
): Promise<void> {
  const update = cachedUpdate ?? (await check());
  if (!update) throw new Error("No update available");

  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress({ downloaded: 0, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
        break;
      case "Finished":
        onProgress({ downloaded: total > 0 ? total : downloaded, total });
        break;
    }
  });

  // Plugin handles install internally; on Linux it spawns pkexec dpkg, on
  // Windows it execs the new NSIS .exe with /UPDATE. We just need to bounce
  // the process so the new binary takes over.
  await relaunch();
}
