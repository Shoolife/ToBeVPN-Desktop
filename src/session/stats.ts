// Persistent local stats for VPN sessions.
// Stores per-hour buckets in localStorage. When VPN is connected,
// call recordTraffic() periodically to accumulate data.

const STORAGE_KEY = "tobevpn_stats_v1";

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

function load(): StatsStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StatsStore;
  } catch {
    // ignore
  }
  return { buckets: [] };
}

function save(store: StatsStore) {
  // Keep last 31 days max (~744 hour buckets)
  const cutoff = floorHour(Date.now() / 1000) - 31 * 86400;
  store.buckets = store.buckets.filter((b) => b.ts >= cutoff);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
}

function floorHour(epochSec: number): number {
  return Math.floor(epochSec / 3600) * 3600;
}

function getOrCreateBucket(store: StatsStore, hourTs: number): HourBucket {
  let bucket = store.buckets.find((b) => b.ts === hourTs);
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
  const store = load();
  const bucket = getOrCreateBucket(store, hourTs);
  bucket.sessions += 1;
  save(store);
}

/** Call periodically while VPN is connected to record traffic delta */
export function recordTraffic(deltaBytes: number, deltaSeconds: number) {
  const hourTs = floorHour(Date.now() / 1000);
  const store = load();
  const bucket = getOrCreateBucket(store, hourTs);
  bucket.bytes += deltaBytes;
  bucket.seconds += deltaSeconds;
  // If the hour rolled over since session started, count a new session
  if (activeSessionHour >= 0 && activeSessionHour !== hourTs) {
    bucket.sessions += 1;
    activeSessionHour = hourTs;
  }
  save(store);
}

/** Call when VPN session ends */
export function sessionEnd() {
  activeSessionHour = -1;
}

// --- Query API used by StatsScreen ---

export interface StatSlot {
  period: number; // epoch seconds
  totalBytes: number;
  sessions: number;
  totalSeconds: number;
}

export function getDayStats(): StatSlot[] {
  const store = load();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(now.getTime() / 1000);

  return Array.from({ length: 24 }, (_, i) => {
    const ts = dayStart + i * 3600;
    const bucket = store.buckets.find((b) => b.ts === ts);
    return {
      period: ts,
      totalBytes: bucket?.bytes ?? 0,
      sessions: bucket?.sessions ?? 0,
      totalSeconds: bucket?.seconds ?? 0,
    };
  });
}

export function getWeekStats(): StatSlot[] {
  const store = load();
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const weekStart = Math.floor(monday.getTime() / 1000);

  return Array.from({ length: 7 }, (_, i) => {
    const dayTs = weekStart + i * 86400;
    // Sum all hour buckets in this day
    let bytes = 0, sessions = 0, seconds = 0;
    for (let h = 0; h < 24; h++) {
      const bucket = store.buckets.find((b) => b.ts === dayTs + h * 3600);
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
  const store = load();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = Math.floor(monthStart.getTime() / 1000);

  return Array.from({ length: 4 }, (_, i) => {
    const weekStart = start + i * 7 * 86400;
    const weekEnd = weekStart + 7 * 86400;
    let bytes = 0, sessions = 0, seconds = 0;
    for (const bucket of store.buckets) {
      if (bucket.ts >= weekStart && bucket.ts < weekEnd) {
        bytes += bucket.bytes;
        sessions += bucket.sessions;
        seconds += bucket.seconds;
      }
    }
    return { period: weekStart, totalBytes: bytes, sessions, totalSeconds: seconds };
  });
}

/** Total bytes ever recorded (all buckets in storage) */
export function getTotalBytes(): number {
  const store = load();
  return store.buckets.reduce((sum, b) => sum + b.bytes, 0);
}
