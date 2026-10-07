import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isAvailableVpnServer, type VpnServer } from "./auth";
import { isBrowserPreviewRuntime } from "./browserPreview";
import { recordDiagnosticEvent } from "./diagnostics";
import { serverProfileKey } from "./serverSelection";
import { preparePingBypass, serverProfileConfig } from "./vpn";

export { serverProfileKey };

// End-to-end server check, as on the phone (ServerListViewModel /
// BaseStationBypassProfileProbeRepository): every server carries a real
// HTTPS request through its complete Xray outbound (src-tauri/server_probe.rs).
// A positive delay means the profile works; -1 that it could not be confirmed.

export interface ServerProbeProgress {
  completed: number;
  total: number;
}

// --- Timeout setting (Android: ServerPingTimeout.kt) ---

export const MIN_SERVER_PING_TIMEOUT_SECONDS = 5;
export const DEFAULT_SERVER_PING_TIMEOUT_SECONDS = 7;
export const MAX_SERVER_PING_TIMEOUT_SECONDS = 15;
const TIMEOUT_KEY = "tobevpn_server_ping_timeout_seconds_v1";

export function normalizeServerPingTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SERVER_PING_TIMEOUT_SECONDS;
  return Math.min(
    MAX_SERVER_PING_TIMEOUT_SECONDS,
    Math.max(MIN_SERVER_PING_TIMEOUT_SECONDS, Math.round(value)),
  );
}

export function getServerPingTimeoutSeconds(): number {
  try {
    const raw = localStorage.getItem(TIMEOUT_KEY);
    return raw === null
      ? DEFAULT_SERVER_PING_TIMEOUT_SECONDS
      : normalizeServerPingTimeoutSeconds(Number(raw));
  } catch {
    return DEFAULT_SERVER_PING_TIMEOUT_SECONDS;
  }
}

export function setServerPingTimeoutSeconds(value: number): void {
  try {
    localStorage.setItem(TIMEOUT_KEY, String(normalizeServerPingTimeoutSeconds(value)));
  } catch {
    // The default stays in effect.
  }
}

// --- Results cache (Android: BaseStationBypassProfileProbeRepository) ---

/** Confirmed and failed results are kept 3 minutes, as on the phone, so a
 *  connection in automatic mode can use the last check instead of a TCP ping. */
const PROFILE_RESULT_TTL_MS = 3 * 60 * 1000;
const profileResults = new Map<string, { delayMs: number; measuredAt: number; timeoutMs: number }>();

const profileKey = serverProfileKey;

/** Fresh results of the last checks for these servers, by serverProfileKey. */
export function getCachedProfileDelays(servers: VpnServer[]): Map<string, number> {
  const now = Date.now();
  const timeoutMs = getServerPingTimeoutSeconds() * 1000;
  const delays = new Map<string, number>();
  for (const server of servers) {
    const cached = profileResults.get(profileKey(server));
    if (
      cached &&
      cached.timeoutMs === timeoutMs &&
      now - cached.measuredAt >= 0 &&
      now - cached.measuredAt <= PROFILE_RESULT_TTL_MS
    ) {
      delays.set(profileKey(server), cached.delayMs);
    }
  }
  return delays;
}

// --- Check ---

interface ProbeResultEvent {
  runId: number;
  serverId: string;
  delayMs: number;
  completed: number;
  total: number;
}

let nextRunId = 1;

export function cancelServerProbe(): void {
  if (isBrowserPreviewRuntime()) return;
  void invoke("cancel_server_probe").catch(() => {});
}

/**
 * Checks the available servers and calls `onResult` as each one finishes.
 * Unavailable (panel-disabled) servers are not checked.
 */
export async function probeServerProfiles(
  servers: VpnServer[],
  onResult: (server: VpnServer, delayMs: number, progress: ServerProbeProgress) => void,
): Promise<Map<string, number>> {
  const candidates = servers.filter(isAvailableVpnServer);
  const results = new Map<string, number>();
  if (candidates.length === 0) return results;
  const timeoutMs = getServerPingTimeoutSeconds() * 1000;

  if (isBrowserPreviewRuntime()) {
    return previewProbe(candidates, onResult);
  }

  const runId = nextRunId++;
  recordDiagnosticEvent(
    "Servers-Check",
    `Xray profile check started; servers=${candidates.length}, timeout_ms=${timeoutMs}`,
    "D",
  );
  // The same host -> IP pinning as the TCP ping: with the tunnel up it also
  // installs direct routes, so the check measures the server itself.
  const addresses = await preparePingBypass(candidates.map((server) => server.address))
    .catch(() => new Map<string, string>());
  // The native side gets run-local ids (the list position), so profiles that
  // share a display id still get their own result.
  // Each index is applied once, from its event or from the final result.
  const delivered = new Set<number>();
  const apply = (index: number, delayMs: number, progress: ServerProbeProgress) => {
    const server = candidates[index];
    if (!server || delivered.has(index)) return;
    delivered.add(index);
    results.set(profileKey(server), delayMs);
    profileResults.set(profileKey(server), {
      delayMs: delayMs > 0 ? delayMs : -1,
      measuredAt: Date.now(),
      timeoutMs,
    });
    onResult(server, delayMs, progress);
  };
  const unlisten = await listen<ProbeResultEvent>("server-probe-result", ({ payload }) => {
    if (payload.runId !== runId) return;
    apply(Number(payload.serverId), payload.delayMs, {
      completed: payload.completed,
      total: payload.total,
    });
  });
  try {
    const final = await invoke<Record<string, number>>("probe_server_profiles", {
      runId,
      timeoutMs,
      servers: candidates.map((server, index) => {
        const address = addresses.get(server.address) ?? server.address;
        return {
          id: String(index),
          // Keep the domain as SNI when the address is pinned to an IP.
          config: serverProfileConfig({
            ...server,
            address,
            sni: server.sni || (address !== server.address ? server.address : ""),
          }),
        };
      }),
    });
    // Events and the command's reply travel separately: the reply can arrive
    // before the last events, which were then lost and their servers shown
    // as unavailable although they had passed. Apply whatever is missing.
    for (const [index, delay] of Object.entries(final)) {
      apply(Number(index), delay, { completed: delivered.size + 1, total: candidates.length });
    }
    const verified = Array.from(results.values()).filter((delay) => delay > 0).length;
    recordDiagnosticEvent(
      "Servers-Check",
      `Xray profile check completed; servers=${candidates.length}, verified=${verified}`,
      "D",
    );
    return results;
  } finally {
    unlisten();
  }
}

/** Browser preview: progressive sample results. */
function previewProbe(
  servers: VpnServer[],
  onResult: (server: VpnServer, delayMs: number, progress: ServerProbeProgress) => void,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  return new Promise((resolve) => {
    servers.forEach((server, index) => {
      window.setTimeout(() => {
        const delay = server.isOnline && index % 4 !== 3 ? 90 + index * 37 : -1;
        results.set(serverProfileKey(server), delay);
        onResult(server, delay, { completed: results.size, total: servers.length });
        if (results.size === servers.length) resolve(results);
      }, 500 + index * 450);
    });
  });
}
