// VPN engine bridge — calls Rust Tauri commands for xray-core + tun2socks.
import { invoke } from "@tauri-apps/api/core";
import { CONTROL_PLANE_BYPASS_HOSTS } from "../api/config";

export interface ServerVpnConfig {
  address: string;
  port: number;
  uuid: string;
  flow?: string;
  security?: string;
  sni?: string;
  fingerprint?: string;
  public_key?: string;
  short_id?: string;
  network?: string;
  path?: string;
  mode?: string;
  spx?: string;
  bypass_hosts?: string[];
}

export type VpnStatus = "Disconnected" | "Connecting" | "Connected" | "Disconnecting" | "Error";

export interface VpnState {
  status: VpnStatus;
  message?: string;
}

export interface TrafficStats {
  uplink: number;
  downlink: number;
}

export async function startVpn(server: ServerVpnConfig): Promise<void> {
  await invoke("start_vpn", {
    server: {
      ...server,
      bypass_hosts: CONTROL_PLANE_BYPASS_HOSTS,
    },
  });
}

export async function stopVpn(): Promise<void> {
  await invoke("stop_vpn");
}

export async function getVpnState(): Promise<VpnState> {
  return await invoke<VpnState>("get_vpn_state");
}

export async function getTrafficStats(): Promise<TrafficStats> {
  return await invoke<TrafficStats>("get_traffic_stats");
}

export async function getXrayVersion(): Promise<string> {
  return await invoke<string>("get_xray_version");
}

export interface PingHostMapping {
  host: string;
  ip: string;
}

/**
 * Resolve each host to its first IPv4 address and — when a tunnel is up —
 * install per-IP bypass routes so the probe never re-enters the VPN. The
 * returned mapping must be used to pin `tcp_ping` to the exact IP a bypass
 * route was added for; calling `tcp_ping` with the hostname would trigger
 * a second `getaddrinfo` that could land on a different rotation and the
 * packet would slip back into the tunnel.
 */
export async function preparePingBypass(
  hosts: string[],
): Promise<Map<string, string>> {
  const uniqueHosts = Array.from(
    new Set(hosts.map((host) => host.trim()).filter(Boolean)),
  );
  if (uniqueHosts.length === 0) return new Map();
  const mapping = await invoke<PingHostMapping[]>("prepare_ping_bypass", {
    hosts: uniqueHosts,
  });
  const out = new Map<string, string>();
  for (const entry of mapping) {
    if (entry.host && entry.ip) out.set(entry.host, entry.ip);
  }
  return out;
}
