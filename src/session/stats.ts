import { invoke } from "@tauri-apps/api/core";

// Persistent local stats for VPN sessions. Older builds stored the complete
// snapshot in WebView localStorage every second. WebKit backs localStorage with
// SQLite, so that pattern could leave a multi-gigabyte WAL file after a long
// VPN session. Stats now live in a small native JSON file and are flushed in
// batches while the in-memory counters remain current for the UI.

const LEGACY_STORAGE_KEY = "tobevpn_stats_v1";
const FLUSH_INTERVAL_MS = 60_000;

export interface HourBucket {
  /** Epoch seconds of the hour start (floored to hour) */
  ts: number;
  /** Total bytes transferred in this hour */
  bytes: number;
  /** Number of distinct sessions that were active */
  sessions: number;
  /** Total connected seconds in this hour */
  seconds: number;
}

interface StatsStore {
  buckets: HourBucket[];
}

function parseStore(raw: string | null): StatsStore | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StatsStore>;
    if (!Array.isArray(parsed.buckets)) return null;
    return {
      buckets: parsed.buckets.filter(
        (bucket): bucket is HourBucket =>
          Number.isFinite(bucket?.ts) &&
          Number.isFinite(bucket?.bytes) &&
          Number.isFinite(bucket?.sessions) &&
          Number.isFinite(bucket?.seconds),
      ),
    };
  } catch {
    return null;
  }
}

function readLegacyStore(): { raw: string | null; store: StatsStore } {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return { raw, store: parseStore(raw) ?? { buckets: [] } };
  } catch {
    return { raw: null, store: { buckets: [] } };
  }
}

function mergeStores(primary: StatsStore, secondary: StatsStore): StatsStore {
  const merged = new Map<number, HourBucket>();
  for (const bucket of [...primary.buckets, ...secondary.buckets]) {
    const current = merged.get(bucket.ts);
    merged.set(
      bucket.ts,
      current
        ? {
            ts: bucket.ts,
            bytes: Math.max(current.bytes, bucket.bytes),
            sessions: Math.max(current.sessions, bucket.sessions),
            seconds: Math.max(current.seconds, bucket.seconds),
          }
        : { ...bucket },
    );
  }
  return { buckets: [...merged.values()] };
}

function floorHour(epochSec: number): number {
  return Math.floor(epochSec / 3600) * 3600;
}

function prune(store: StatsStore) {
  // Keep last 31 days max (~744 hour buckets).
  const cutoff = floorHour(Date.now() / 1000) - 31 * 86400;
  store.buckets = store.buckets.filter((bucket) => bucket.ts >= cutoff);
}

const legacy = readLegacyStore();
let store = legacy.store;
let nativeStorageReady = false;
let dirty = false;
let flushTimer: number | null = null;
let saveChain: Promise<void> = Promise.resolve();

function load(): StatsStore {
  return store;
}

function scheduleSave() {
  dirty = true;
  if (!nativeStorageReady || flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void persistNow();
  }, FLUSH_INTERVAL_MS);
}

function persistNow(): Promise<void> {
  if (!nativeStorageReady || !dirty) return saveChain;
  dirty = false;
  prune(store);
  const payload = JSON.stringify(store);
  const pending = saveChain
    .catch(() => undefined)
    .then(() => invoke<void>("save_desktop_stats", { payload }));
  saveChain = pending.catch((error) => {
    dirty = true;
    scheduleSave();
    console.warn("Could not save desktop stats", error);
  });
  return pending;
}

function flushStats() {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  void persistNow();
}

async function initializeNativeStorage() {
  try {
    const raw = await invoke<string | null>("load_desktop_stats");
    const nativeStore = parseStore(raw);
    if (nativeStore) {
      // Merge with counters collected while the asynchronous native read was
      // running. max() also avoids double-counting the legacy migration.
      store = mergeStores(nativeStore, store);
    }
    nativeStorageReady = true;
    if (legacy.raw !== null) {
      dirty = true;
      await persistNow();
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // The native file is authoritative now. A leftover legacy snapshot is
        // harmless and will be retried on the next launch.
      }
    } else if (dirty) {
      scheduleSave();
    }
  } catch (error) {
    console.warn("Could not initialize native desktop stats", error);
  }
}

void initializeNativeStorage();
window.addEventListener("pagehide", flushStats);
window.addEventListener("beforeunload", flushStats);

function getOrCreateBucket(store: StatsStore, hourTs: number): HourBucket {
  let bucket = store.buckets.find((item) => item.ts === hourTs);
  if (!bucket) {
    bucket = { ts: hourTs, bytes: 0, sessions: 0, seconds: 0 };
    store.buckets.push(bucket);
  }
  return bucket;
}

// --- Public API called by VPN engine ---

let activeSessionHour = -1;

/** Call when a VPN session starts */
export function sessionStart() {
  const hourTs = floorHour(Date.now() / 1000);
  activeSessionHour = hourTs;
  const bucket = getOrCreateBucket(load(), hourTs);
  bucket.sessions += 1;
  scheduleSave();
}

/** Call periodically while VPN is connected to record traffic delta */
export function recordTraffic(deltaBytes: number, deltaSeconds: number) {
  const hourTs = floorHour(Date.now() / 1000);
  const bucket = getOrCreateBucket(load(), hourTs);
  bucket.bytes += deltaBytes;
  bucket.seconds += deltaSeconds;
  // If the hour rolled over since session started, count a new session.
  if (activeSessionHour >= 0 && activeSessionHour !== hourTs) {
    bucket.sessions += 1;
    activeSessionHour = hourTs;
  }
  scheduleSave();
}

/** Call when VPN session ends */
export function sessionEnd() {
  activeSessionHour = -1;
  flushStats();
}

// --- Query API used by StatsScreen ---

export interface StatSlot {
  period: number; // epoch seconds
  totalBytes: number;
  sessions: number;
  totalSeconds: number;
}

export function getDayStats(): StatSlot[] {
  const stats = load();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(now.getTime() / 1000);

  return Array.from({ length: 24 }, (_, i) => {
    const ts = dayStart + i * 3600;
    const bucket = stats.buckets.find((item) => item.ts === ts);
    return {
      period: ts,
      totalBytes: bucket?.bytes ?? 0,
      sessions: bucket?.sessions ?? 0,
      totalSeconds: bucket?.seconds ?? 0,
    };
  });
}

export function getWeekStats(): StatSlot[] {
  const stats = load();
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const weekStart = Math.floor(monday.getTime() / 1000);

  return Array.from({ length: 7 }, (_, i) => {
    const dayTs = weekStart + i * 86400;
    // Sum all hour buckets in this day.
    let bytes = 0, sessions = 0, seconds = 0;
    for (let h = 0; h < 24; h++) {
      const bucket = stats.buckets.find((item) => item.ts === dayTs + h * 3600);
      if (bucket) {
        bytes += bucket.bytes;
        sessions += bucket.sessions;
        seconds += bucket.seconds;
      }
    }
    return { period: dayTs, totalBytes: bytes, sessions, totalSeconds: seconds };
  });
}

export function getMonthStats(): StatSlot[] {
  const stats = load();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = Math.floor(monthStart.getTime() / 1000);

  return Array.from({ length: 4 }, (_, i) => {
    const weekStart = start + i * 7 * 86400;
    const weekEnd = weekStart + 7 * 86400;
    let bytes = 0, sessions = 0, seconds = 0;
    for (const bucket of stats.buckets) {
      if (bucket.ts >= weekStart && bucket.ts < weekEnd) {
        bytes += bucket.bytes;
        sessions += bucket.sessions;
        seconds += bucket.seconds;
      }
    }
    return { period: weekStart, totalBytes: bytes, sessions, totalSeconds: seconds };
  });
}

/** Total bytes ever recorded in the retained buckets. */
export function getTotalBytes(): number {
  return load().buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
}
