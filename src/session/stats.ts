import { invoke } from "@tauri-apps/api/core";

// Persistent local stats for VPN sessions. Older builds stored the complete
// snapshot in WebView localStorage every second. WebKit backs localStorage with
// SQLite, so that pattern could leave a multi-gigabyte WAL file after a long
// VPN session. Stats now live in a small native JSON file and are flushed in
// batches while the in-memory counters remain current for the UI.

const LEGACY_STORAGE_KEY = "tobevpn_stats_v1";
const FLUSH_INTERVAL_MS = 10_000;
const STATS_CHANGED_EVENT = "tobevpn:stats-changed";
const MAX_STORED_BUCKETS = 800;
const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;
const NATIVE_INIT_RETRY_MS = 5_000;
const NATIVE_INIT_MAX_ATTEMPTS = 3;

export interface HourBucket {
  /** Epoch seconds of the local wall-clock hour start */
  ts: number;
  /** Total bytes transferred in this hour */
  bytes: number;
  /** Number of VPN sessions started in this hour */
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
    const newestAllowed = floorHour(Date.now() / 1000) + 3600;
    const oldestAllowed = newestAllowed - 32 * 86400;
    const unique = new Map<number, HourBucket>();
    for (const candidate of parsed.buckets.slice(0, MAX_STORED_BUCKETS * 4)) {
      const bucket = candidate as Partial<HourBucket> | null;
      const ts = Number(bucket?.ts);
      const bytes = Number(bucket?.bytes);
      const sessions = Number(bucket?.sessions);
      const seconds = Number(bucket?.seconds);
      if (
        !bucket ||
        !Number.isSafeInteger(ts) ||
        ts < oldestAllowed ||
        ts > newestAllowed ||
        // Local hour boundaries are not always divisible by 3600 in UTC
        // (for example India is UTC+05:30 and Nepal is UTC+05:45).
        ts % 60 !== 0 ||
        !Number.isFinite(bytes) ||
        bytes < 0 ||
        bytes > MAX_COUNTER_VALUE ||
        !Number.isFinite(sessions) ||
        sessions < 0 ||
        sessions > MAX_COUNTER_VALUE ||
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        seconds > MAX_COUNTER_VALUE
      ) continue;
      const normalized: HourBucket = {
        ts,
        bytes: Math.floor(bytes),
        sessions: Math.floor(sessions),
        seconds: Math.floor(seconds),
      };
      const existing = unique.get(normalized.ts);
      unique.set(normalized.ts, existing ? {
        ts: normalized.ts,
        bytes: Math.max(existing.bytes, normalized.bytes),
        sessions: Math.max(existing.sessions, normalized.sessions),
        seconds: Math.max(existing.seconds, normalized.seconds),
      } : normalized);
    }
    return {
      buckets: [...unique.values()]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX_STORED_BUCKETS)
        .sort((a, b) => a.ts - b.ts),
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

function mergeNativeWithRuntime(
  nativeStore: StatsStore,
  startupBaseline: StatsStore,
  runtimeStore: StatsStore,
): StatsStore {
  const merged = mergeStores(nativeStore, startupBaseline);
  const baselineByTs = new Map(startupBaseline.buckets.map((bucket) => [bucket.ts, bucket]));
  for (const runtimeBucket of runtimeStore.buckets) {
    const baseline = baselineByTs.get(runtimeBucket.ts);
    const target = getOrCreateBucket(merged, runtimeBucket.ts);
    target.bytes = Math.min(
      MAX_COUNTER_VALUE,
      target.bytes + Math.max(0, runtimeBucket.bytes - (baseline?.bytes ?? 0)),
    );
    target.sessions = Math.min(
      MAX_COUNTER_VALUE,
      target.sessions + Math.max(0, runtimeBucket.sessions - (baseline?.sessions ?? 0)),
    );
    target.seconds = Math.min(
      MAX_COUNTER_VALUE,
      target.seconds + Math.max(0, runtimeBucket.seconds - (baseline?.seconds ?? 0)),
    );
  }
  return merged;
}

function floorHour(epochSec: number): number {
  const date = new Date(epochSec * 1000);
  date.setMinutes(0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function prune(store: StatsStore) {
  // Keep last 31 days max (~744 hour buckets).
  const cutoff = floorHour(Date.now() / 1000) - 31 * 86400;
  store.buckets = store.buckets.filter((bucket) => bucket.ts >= cutoff);
}

const legacy = readLegacyStore();
const startupBaseline: StatsStore = {
  buckets: legacy.store.buckets.map((bucket) => ({ ...bucket })),
};
let store = legacy.store;
let nativeStorageReady = false;
let dirty = false;
let flushTimer: number | null = null;
let saveChain: Promise<void> = Promise.resolve();
let nativeInitAttempts = 0;

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
  nativeInitAttempts += 1;
  try {
    const raw = await invoke<string | null>("load_desktop_stats");
    const nativeStore = parseStore(raw);
    if (nativeStore) {
      // Avoid double-counting the legacy snapshot while still ADDING counters
      // recorded during the asynchronous native read.
      store = mergeNativeWithRuntime(nativeStore, startupBaseline, store);
    }
    nativeStorageReady = true;
    window.dispatchEvent(new Event(STATS_CHANGED_EVENT));
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
    if (nativeInitAttempts < NATIVE_INIT_MAX_ATTEMPTS) {
      window.setTimeout(() => void initializeNativeStorage(), NATIVE_INIT_RETRY_MS);
    }
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

/** Call when a VPN session starts */
export function sessionStart() {
  const hourTs = floorHour(Date.now() / 1000);
  const bucket = getOrCreateBucket(load(), hourTs);
  bucket.sessions = Math.min(MAX_COUNTER_VALUE, bucket.sessions + 1);
  scheduleSave();
  window.dispatchEvent(new Event(STATS_CHANGED_EVENT));
}

/** Call periodically while VPN is connected to record traffic delta */
export function recordTraffic(deltaBytes: number, deltaSeconds: number) {
  if (!Number.isFinite(deltaBytes) || !Number.isFinite(deltaSeconds)) return;
  const safeBytes = Math.min(MAX_COUNTER_VALUE, Math.max(0, Math.floor(deltaBytes)));
  const safeSeconds = Math.min(3600, Math.max(0, deltaSeconds));
  const hourTs = floorHour(Date.now() / 1000);
  const bucket = getOrCreateBucket(load(), hourTs);
  bucket.bytes = Math.min(MAX_COUNTER_VALUE, bucket.bytes + safeBytes);
  bucket.seconds = Math.min(MAX_COUNTER_VALUE, bucket.seconds + safeSeconds);
  scheduleSave();
  window.dispatchEvent(new Event(STATS_CHANGED_EVENT));
}

/** Call when VPN session ends */
export function sessionEnd() {
  flushStats();
}

export function subscribeStats(listener: () => void): () => void {
  window.addEventListener(STATS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(STATS_CHANGED_EVENT, listener);
}

// --- Query API used by StatsScreen ---

export interface StatSlot {
  period: number; // epoch seconds
  totalBytes: number;
  sessions: number;
  totalSeconds: number;
}

// Buckets are aligned to the local wall-clock hour at recording time. Range
// checks also keep older buckets usable after a timezone or DST transition.
function slotFromRange(store: StatsStore, startSec: number, endSec: number): StatSlot {
  let bytes = 0, sessions = 0, seconds = 0;
  for (const bucket of store.buckets) {
    if (bucket.ts >= startSec && bucket.ts < endSec) {
      bytes += bucket.bytes;
      sessions += bucket.sessions;
      seconds += bucket.seconds;
    }
  }
  return { period: startSec, totalBytes: bytes, sessions, totalSeconds: seconds };
}

export function getDayStats(): StatSlot[] {
  const stats = load();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const slots: StatSlot[] = [];
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += 3600_000) {
    slots.push(slotFromRange(stats, cursor / 1000, Math.min(cursor + 3600_000, end.getTime()) / 1000));
  }
  return slots;
}

export function getWeekStats(): StatSlot[] {
  const stats = load();
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date(monday);
    dayStart.setDate(monday.getDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);
    return slotFromRange(stats, dayStart.getTime() / 1000, dayEnd.getTime() / 1000);
  });
}

export function getMonthStats(): StatSlot[] {
  const stats = load();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const slots: StatSlot[] = [];
  for (let weekStart = new Date(monthStart); weekStart < monthEnd;) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);
    const cappedEnd = weekEnd < monthEnd ? weekEnd : monthEnd;
    slots.push(slotFromRange(stats, weekStart.getTime() / 1000, cappedEnd.getTime() / 1000));
    weekStart = weekEnd;
  }
  return slots;
}

/** Total bytes ever recorded in the retained buckets. */
export function getTotalBytes(): number {
  return load().buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
}
