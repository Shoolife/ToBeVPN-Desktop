import { invoke } from "@tauri-apps/api/core";
import type { VpnServer } from "./auth";
import { preparePingBypass } from "./vpn";
import { isBrowserPreviewRuntime } from "./browserPreview";

const STORAGE_KEY = "tobevpn_server_quality_v1";
const PING_TIMEOUT_MS = 3_000;
const PING_CACHE_TTL_MS = 15_000;
const HEALTHY_WRITE_INTERVAL_MS = 5 * 60 * 1_000;
const FAILURE_FULL_PENALTY_MS = 30 * 60 * 1_000;
const FAILURE_DECAY_MS = 6 * 60 * 60 * 1_000;
const RECENT_HEALTHY_BONUS_MS = 24 * 60 * 60 * 1_000;
const RECENT_TRAFFIC_BONUS_MS = 24 * 60 * 60 * 1_000;
const RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const FAILURE_PENALTY_MS = 600;
const MAX_RELIABILITY_PENALTY_MS = 120;
const MIN_RELIABILITY_SAMPLES = 3;
const TRAFFIC_BONUS_STEP_BYTES = 10 * 1024 * 1024;
const MAX_CONFIRMED_TRAFFIC_BYTES = 50 * 1024 * 1024;
const MAX_COUNTER = 100;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_RECORDS = 100;
const MAX_CONCURRENT_PINGS = 6;

export interface ServerQualityIdentity {
  address: string;
  port: number;
  sni?: string | null;
}

export interface MeasuredVpnServer extends VpnServer {
  ping: number;
}

interface QualityRecord {
  successfulConnections: number;
  failedConnections: number;
  consecutiveFailures: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  lastHealthyAt: number;
  lastTrafficAt: number;
  confirmedTrafficBytes: number;
}

interface QualityState {
  records: Record<string, QualityRecord>;
}

interface TimedPing {
  ping: number;
  measuredAt: number;
}

const pingCache = new Map<string, TimedPing>();
let cachedState: QualityState | null = null;
let stateWriteQueue = Promise.resolve();

function emptyRecord(): QualityRecord {
  return {
    successfulConnections: 0,
    failedConnections: 0,
    consecutiveFailures: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastHealthyAt: 0,
    lastTrafficAt: 0,
    confirmedTrafficBytes: 0,
  };
}

function qualityKey(server: ServerQualityIdentity): string {
  return `${server.address}:${server.port}:${server.sni ?? ""}`;
}

function isAvailableServer(server: VpnServer): boolean {
  return (
    server.uuid !== "00000000-0000-0000-0000-000000000000" &&
    Boolean(server.address) &&
    server.address !== "127.0.0.1" &&
    server.address !== "0.0.0.0" &&
    !/истекла|expired/i.test(server.name)
  );
}

function isQualityRecord(value: unknown): value is QualityRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const counter = (item: unknown, max: number) =>
    Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= max;
  const timestamp = (item: unknown) =>
    Number.isSafeInteger(item) &&
    Number(item) >= 0 &&
    Number(item) <= Date.now() + 24 * 60 * 60 * 1_000;
  return (
    counter(record.successfulConnections, MAX_COUNTER) &&
    counter(record.failedConnections, MAX_COUNTER) &&
    counter(record.consecutiveFailures, MAX_CONSECUTIVE_FAILURES) &&
    timestamp(record.lastSuccessAt) &&
    timestamp(record.lastFailureAt) &&
    timestamp(record.lastHealthyAt) &&
    timestamp(record.lastTrafficAt) &&
    counter(record.confirmedTrafficBytes, MAX_CONFIRMED_TRAFFIC_BYTES)
  );
}

function readState(): QualityState {
  if (cachedState) return cachedState;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedState = { records: {} };
      return cachedState;
    }
    const parsed = JSON.parse(raw) as { records?: unknown };
    const source =
      parsed.records && typeof parsed.records === "object"
        ? (parsed.records as Record<string, unknown>)
        : {};
    const records: Record<string, QualityRecord> = {};
    for (const [key, value] of Object.entries(source).slice(0, MAX_RECORDS * 4)) {
      if (key.length <= 512 && !/[\u0000-\u001f\u007f]/.test(key) && isQualityRecord(value)) {
        records[key] = value;
      }
    }
    cachedState = { records };
  } catch {
    cachedState = { records: {} };
  }
  return cachedState;
}

function newestTimestamp(record: QualityRecord): number {
  return Math.max(
    record.lastSuccessAt,
    record.lastFailureAt,
    record.lastHealthyAt,
    record.lastTrafficAt,
  );
}

function persistState(state: QualityState): void {
  cachedState = state;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quality history is an optimization. A storage failure must not block VPN.
  }
}

function updateRecord(
  server: ServerQualityIdentity,
  transform: (current: QualityRecord, now: number) => QualityRecord,
  minWriteIntervalMs = 0,
): Promise<void> {
  stateWriteQueue = stateWriteQueue.then(() => {
    const state = readState();
    const key = qualityKey(server);
    const current = state.records[key] ?? emptyRecord();
    const now = Date.now();
    if (
      minWriteIntervalMs > 0 &&
      now >= current.lastHealthyAt &&
      now - current.lastHealthyAt < minWriteIntervalMs &&
      current.lastFailureAt <= current.lastHealthyAt
    ) {
      return;
    }
    const records = Object.entries(state.records)
      .filter(([, record]) => newestTimestamp(record) >= now - RECORD_RETENTION_MS)
      .sort((a, b) => newestTimestamp(b[1]) - newestTimestamp(a[1]))
      .slice(0, MAX_RECORDS - 1)
      .reduce<Record<string, QualityRecord>>((out, [recordKey, record]) => {
        out[recordKey] = record;
        return out;
      }, {});
    records[key] = transform(current, now);
    persistState({ records });
  });
  return stateWriteQueue;
}

function nextConsecutiveFailures(record: QualityRecord, now: number): number {
  const previous =
    record.lastFailureAt <= 0 ||
    now < record.lastFailureAt ||
    now - record.lastFailureAt >= FAILURE_DECAY_MS
      ? 0
      : record.consecutiveFailures;
  return Math.min(previous + 1, MAX_CONSECUTIVE_FAILURES);
}

function recencyBonus(timestamp: number, now: number, windowMs: number, maxBonus: number): number {
  if (timestamp <= 0) return 0;
  const age = Math.max(0, now - timestamp);
  if (age >= windowMs) return 0;
  return maxBonus * (1 - age / windowMs);
}

function qualityScore(ping: number, record: QualityRecord | undefined, now: number): number {
  if (!record) return ping;
  const failureAge = now - record.lastFailureAt;
  const failureWeight =
    record.lastFailureAt <= 0 || failureAge >= FAILURE_DECAY_MS
      ? 0
      : failureAge <= FAILURE_FULL_PENALTY_MS
        ? 1
        : 1 -
          (failureAge - FAILURE_FULL_PENALTY_MS) /
            (FAILURE_DECAY_MS - FAILURE_FULL_PENALTY_MS);
  const failurePenalty =
    record.consecutiveFailures * FAILURE_PENALTY_MS * failureWeight;
  const observedConnections =
    record.successfulConnections + record.failedConnections;
  const reliabilityPenalty =
    observedConnections >= MIN_RELIABILITY_SAMPLES
      ? (record.failedConnections / observedConnections) * MAX_RELIABILITY_PENALTY_MS
      : 0;
  const successBonus = Math.min(record.successfulConnections, 4) * 5;
  const healthyBonus = recencyBonus(
    record.lastHealthyAt,
    now,
    RECENT_HEALTHY_BONUS_MS,
    25,
  );
  const trafficBonus = recencyBonus(
    record.lastTrafficAt,
    now,
    RECENT_TRAFFIC_BONUS_MS,
    40,
  );
  const trafficVolumeBonus =
    Math.min(Math.floor(record.confirmedTrafficBytes / TRAFFIC_BONUS_STEP_BYTES), 5) * 3;
  return (
    ping +
    failurePenalty +
    reliabilityPenalty -
    successBonus -
    healthyBonus -
    trafficBonus -
    trafficVolumeBonus
  );
}

export async function measureVpnServerPings(
  servers: VpnServer[],
  options: { force?: boolean } = {},
): Promise<Map<string, number>> {
  if (isBrowserPreviewRuntime()) {
    return new Map(
      servers.map((server, index) => [
        server.id,
        isAvailableServer(server) && server.isOnline ? 42 + index * 18 : -1,
      ]),
    );
  }

  const now = Date.now();
  const result = new Map<string, number>();
  const pending: VpnServer[] = [];
  for (const server of servers) {
    if (!isAvailableServer(server)) {
      result.set(server.id, -1);
      continue;
    }
    const cached = pingCache.get(qualityKey(server));
    const cacheAge = cached ? now - cached.measuredAt : -1;
    if (!options.force && cached && cacheAge >= 0 && cacheAge <= PING_CACHE_TTL_MS) {
      result.set(server.id, cached.ping);
    } else {
      pending.push(server);
    }
  }
  if (pending.length === 0) return result;

  const targets = await preparePingBypass(pending.map((server) => server.address))
    .catch(() => new Map<string, string>());
  let nextServerIndex = 0;
  const worker = async () => {
    while (nextServerIndex < pending.length) {
      const server = pending[nextServerIndex++];
      const target = targets.get(server.address) ?? server.address;
      let ping = -1;
      try {
        const measured = await invoke<number>("tcp_ping", {
          host: target,
          port: server.port,
          timeoutMs: PING_TIMEOUT_MS,
        });
        ping = measured >= 0 ? Math.max(measured, 1) : -1;
      } catch {
        ping = -1;
      }
      pingCache.set(qualityKey(server), { ping, measuredAt: Date.now() });
      result.set(server.id, ping);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_PINGS, pending.length) },
      () => worker(),
    ),
  );
  return result;
}

export async function measureVpnServerPing(
  server: VpnServer,
  options: { force?: boolean } = {},
): Promise<number> {
  const pings = await measureVpnServerPings([server], options);
  return pings.get(server.id) ?? -1;
}

export async function selectBestVpnServer(
  servers: VpnServer[],
  options: { excludeServerId?: string; forceProbe?: boolean } = {},
): Promise<MeasuredVpnServer | null> {
  const available = servers.filter(isAvailableServer);
  if (available.length === 0) return null;
  const preferred = available.filter((server) => server.id !== options.excludeServerId);
  const candidates = preferred.length > 0 ? preferred : available;
  const pings = await measureVpnServerPings(available, { force: options.forceProbe });
  const records = readState().records;
  const now = Date.now();
  const preferPanelOnline = (rankCandidates: VpnServer[]): VpnServer[] => {
    const online = rankCandidates.filter((server) => server.isOnline);
    return online.length > 0 ? online : rankCandidates;
  };
  const rank = (rankCandidates: VpnServer[]): MeasuredVpnServer | null => {
    const ranked = rankCandidates
      .map((server) => {
        const ping = pings.get(server.id) ?? -1;
        return ping < 0
          ? null
          : {
              server: { ...server, ping },
              score: qualityScore(ping, records[qualityKey(server)], now),
            };
      })
      .filter(
        (entry): entry is { server: MeasuredVpnServer; score: number } => entry !== null,
      )
      .sort(
        (a, b) =>
          a.score - b.score ||
          a.server.ping - b.server.ping ||
          a.server.name.localeCompare(b.server.name),
    );
    return ranked[0]?.server ?? null;
  };
  const onlineCandidates = preferPanelOnline(available);
  const preferredOnlineCandidates = preferPanelOnline(candidates);
  return (
    rank(preferredOnlineCandidates) ??
    rank(candidates) ??
    rank(onlineCandidates) ??
    rank(available) ??
    (preferredOnlineCandidates[0]
      ? {
          ...preferredOnlineCandidates[0],
          ping: pings.get(preferredOnlineCandidates[0].id) ?? -1,
        }
      : null)
  );
}

export function recordServerConnectionSuccess(server: ServerQualityIdentity): Promise<void> {
  return updateRecord(server, (current, now) => ({
    ...current,
    successfulConnections: Math.min(current.successfulConnections + 1, MAX_COUNTER),
    lastSuccessAt: now,
  }));
}

export function recordServerConnectionFailure(server: ServerQualityIdentity): Promise<void> {
  return updateRecord(server, (current, now) => ({
    ...current,
    failedConnections: Math.min(current.failedConnections + 1, MAX_COUNTER),
    consecutiveFailures: nextConsecutiveFailures(current, now),
    lastFailureAt: now,
  }));
}

export function recordServerTunnelHealthy(server: ServerQualityIdentity): Promise<void> {
  return updateRecord(
    server,
    (current, now) => ({
      ...current,
      consecutiveFailures: 0,
      lastHealthyAt: now,
    }),
    HEALTHY_WRITE_INTERVAL_MS,
  );
}

export function recordServerTunnelFailure(server: ServerQualityIdentity): Promise<void> {
  return updateRecord(server, (current, now) => ({
    ...current,
    failedConnections: Math.min(current.failedConnections + 1, MAX_COUNTER),
    consecutiveFailures: nextConsecutiveFailures(current, now),
    lastFailureAt: now,
  }));
}

export function recordServerTraffic(
  server: ServerQualityIdentity,
  bytes: number,
): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return Promise.resolve();
  const safeBytes = Math.min(Math.floor(bytes), MAX_CONFIRMED_TRAFFIC_BYTES);
  return updateRecord(server, (current, now) => ({
    ...current,
    consecutiveFailures: 0,
    lastTrafficAt: now,
    confirmedTrafficBytes: Math.min(
      current.confirmedTrafficBytes + safeBytes,
      MAX_CONFIRMED_TRAFFIC_BYTES,
    ),
  }));
}
