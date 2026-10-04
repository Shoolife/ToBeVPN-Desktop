import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isAvailableVpnServer, type VpnServer } from "./auth";
import { isBrowserPreviewRuntime } from "./browserPreview";
import { recordDiagnosticEvent } from "./diagnostics";
import { preparePingBypass } from "./vpn";

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
  onResult: (serverId: string, delayMs: number, progress: ServerProbeProgress) => void,
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
  const unlisten = await listen<ProbeResultEvent>("server-probe-result", ({ payload }) => {
    if (payload.runId !== runId) return;
    results.set(payload.serverId, payload.delayMs);
    onResult(payload.serverId, payload.delayMs, {
      completed: payload.completed,
      total: payload.total,
    });
  });
  try {
    const final = await invoke<Record<string, number>>("probe_server_profiles", {
      runId,
      timeoutMs,
      servers: candidates.map((server) => {
        const address = addresses.get(server.address) ?? server.address;
        return {
          id: server.id,
          config: {
            address,
            port: server.port,
            uuid: server.uuid,
            flow: server.flow,
            security: server.security,
            // Keep the domain as SNI when the address is pinned to an IP.
            sni: server.sni || (address !== server.address ? server.address : ""),
            fingerprint: server.fingerprint,
            public_key: server.public_key,
            short_id: server.short_id,
            network: server.network,
            path: server.path,
            mode: server.mode,
            spx: server.spx,
          },
        };
      }),
    });
    for (const [id, delay] of Object.entries(final)) results.set(id, delay);
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
  onResult: (serverId: string, delayMs: number, progress: ServerProbeProgress) => void,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  return new Promise((resolve) => {
    servers.forEach((server, index) => {
      window.setTimeout(() => {
        const delay = server.isOnline && index % 4 !== 3 ? 90 + index * 37 : -1;
        results.set(server.id, delay);
        onResult(server.id, delay, { completed: results.size, total: servers.length });
        if (results.size === servers.length) resolve(results);
      }, 500 + index * 450);
    });
  });
}
