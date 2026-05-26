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
