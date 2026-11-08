// Home router detection for the Router section (Devices screen).
//
// The native side finds the default gateway and reads the router's login
// page, which needs no password. Store builds have no Router section: they
// cannot run SSH or install software on another device.
import { invoke } from "@tauri-apps/api/core";
import type { LinkedDeviceDto } from "../api/types";
import { SUBSCRIPTION_BASE_URL } from "../api/config";
import { isBrowserPreviewRuntime } from "./browserPreview";
import { getSession } from "./store";
import type { ServerVpnConfig } from "./vpn";
import { getCachedVpnServers } from "./auth";

export interface RouterInfo {
  /** Default gateway, e.g. "192.168.1.1"; null without a network. */
  gateway: string | null;
  /** Model from the login page, e.g. "SNR-CPE-AX2". */
  model: string | null;
  /** "easywrt" (SNR's OpenWrt), "openwrt", or null when not recognised. */
  firmware: string | null;
  /** The installer has been verified on this model. */
  supported: boolean;
}

export const ROUTER_SECTION_AVAILABLE = !import.meta.env.VITE_STORE_BUILD;

const EMPTY: RouterInfo = { gateway: null, model: null, firmware: null, supported: false };

let cached: RouterInfo | null = null;
let inFlight: Promise<RouterInfo> | null = null;

/** Detected router; cached for the session unless `refresh` is set. */
export async function detectRouter(refresh = false): Promise<RouterInfo> {
  if (!ROUTER_SECTION_AVAILABLE || isBrowserPreviewRuntime()) return EMPTY;
  if (cached && !refresh) return cached;
  if (inFlight) return inFlight;
  inFlight = invoke<RouterInfo>("detect_router")
    .then((info) => {
      cached = info;
      return info;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function getCachedRouter(): RouterInfo | null {
  return cached;
}

/** Human-readable firmware family. */
export function routerFirmwareLabel(firmware: string | null): string | null {
  if (firmware === "easywrt") return "EasyWRT";
  if (firmware === "openwrt") return "OpenWrt";
  return null;
}

/**
 * A router linked to the account fetches its subscription with a "/router/"
 * User-Agent and OpenWrt as its OS. Such a device is shown once, as the
 * router card, not again in the list of other devices.
 */
export function isRouterDevice(device: LinkedDeviceDto): boolean {
  const userAgent = (device.user_agent ?? "").toLowerCase();
  const platform = (device.platform ?? "").toLowerCase();
  const type = (device.device_type ?? "").toLowerCase();
  return type === "router" || userAgent.includes("/router/") || platform === "openwrt";
}

// ---------------------------------------------------------------- agent ---

export interface RouterStatus {
  installed: boolean;
  running: boolean;
  autostart: boolean;
  xrayMemoryKb: number | null;
  memoryAvailableKb: number | null;
  tunnelRxBytes: number;
  tunnelTxBytes: number;
  /** Mode of devices without their own choice. */
  defaultMode: RouterDeviceMode;
  /** This computer's address in the home network, as the router sees it. */
  clientIp: string | null;
  subscriptionUsedBytes: number | null;
  subscriptionTotalBytes: number | null;
  /** The core does not start: the home is direct, the router retries every minute. */
  failed: boolean;
  /** Slots whose server does not answer; 0 means the whole home is direct for now. */
  downSlots: number[];
  serverBypassRules: number;
}

export type RouterDeviceMode = "vpn" | "direct";

export interface RouterDevice {
  mac: string;
  ip: string | null;
  /** Name the device reported over DHCP. */
  hostname: string | null;
  /** Own choice, or "default" to follow the router's default mode. */
  mode: RouterDeviceMode | "default";
  /** Name the user gave the device. */
  name: string | null;
  online: boolean;
  /** Server slot when the mode is "vpn": 0 is the router's server. */
  slot: number;
}

/** A server in a slot of the router: 0 is the router's own, 1-3 of single devices. */
export interface RouterSlot {
  slot: number;
  serverId: string;
  serverName: string;
}

export interface RouterNetwork {
  devices: RouterDevice[];
  slots: RouterSlot[];
}

/** Extra servers for single devices, besides the router's own. */
export const ROUTER_EXTRA_SLOTS = 3;

export interface SlotServer {
  slot: number;
  id: string;
  name: string;
  server: ServerVpnConfig;
}

/** The router this app manages: address, SSH login and the chosen server. */
export interface RouterLink {
  host: string;
  user: string;
  serverId: string | null;
  serverName: string | null;
}

const LINK_KEY = "tobevpn_router_v1";

export function getRouterLink(): RouterLink | null {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RouterLink>;
    if (typeof parsed.host !== "string" || typeof parsed.user !== "string") return null;
    return {
      host: parsed.host,
      user: parsed.user,
      serverId: typeof parsed.serverId === "string" ? parsed.serverId : null,
      serverName: typeof parsed.serverName === "string" ? parsed.serverName : null,
    };
  } catch {
    return null;
  }
}

function saveRouterLink(link: RouterLink | null): void {
  try {
    if (link) localStorage.setItem(LINK_KEY, JSON.stringify(link));
    else localStorage.removeItem(LINK_KEY);
  } catch {
    // Without storage the router is paired again next time.
  }
}

/** SSH login of the router's administrator by firmware family. */
export function defaultRouterUser(info: RouterInfo | null): string {
  return info?.firmware === "easywrt" ? "Admin" : "root";
}

/**
 * Pairs with the router (the password is used once and not stored) and
 * installs or updates ToBeVPN on it with the given server.
 */
export async function installRouter(options: {
  host: string;
  user: string;
  password: string;
  server: SlotServer;
  subscriptionUrl: string;
  autostart: boolean;
}): Promise<RouterStatus> {
  const { host, user, password, server, subscriptionUrl, autostart } = options;
  const serverHosts = accountServerHosts();
  await invoke("router_pair", { host, user, password });
  const status = await invoke<RouterStatus>("router_install", {
    host,
    user,
    servers: [{ ...server, slot: 0 }],
    serverHosts,
    subscriptionUrl,
    autostart,
  });
  saveRouterLink({ host, user, serverId: server.id, serverName: server.name });
  return status;
}

export async function routerStatus(link: RouterLink): Promise<RouterStatus> {
  return invoke<RouterStatus>("router_status", { host: link.host, user: link.user });
}

export type RouterAction = "start" | "stop" | "restart" | "autostart-on" | "autostart-off" | "uninstall";

export async function routerControl(link: RouterLink, action: RouterAction): Promise<RouterStatus> {
  const status = await invoke<RouterStatus>("router_control", {
    host: link.host,
    user: link.user,
    action,
  });
  if (action === "uninstall") saveRouterLink(null);
  return status;
}

/** Sets the router's server (slot 0) and the servers of single devices; restarts the tunnels. */
export async function setRouterServers(link: RouterLink, servers: SlotServer[]): Promise<RouterStatus> {
  const main = servers.find((server) => server.slot === 0);
  if (!main) throw new Error("the router server is missing");
  const status = await invoke<RouterStatus>("router_set_servers", {
    host: link.host,
    user: link.user,
    servers,
    serverHosts: accountServerHosts(),
  });
  saveRouterLink({ ...link, serverId: main.id, serverName: main.name });
  return status;
}

export async function routerDevices(link: RouterLink): Promise<RouterNetwork> {
  return invoke<RouterNetwork>("router_devices", { host: link.host, user: link.user });
}

export async function setRouterDevice(
  link: RouterLink,
  device: { mac: string; mode: RouterDevice["mode"]; slot: number; name: string },
): Promise<void> {
  await invoke("router_set_device", { host: link.host, user: link.user, ...device });
}

export async function setRouterDefaultMode(
  link: RouterLink,
  mode: RouterDeviceMode,
): Promise<RouterStatus> {
  return invoke<RouterStatus>("router_set_default_mode", { host: link.host, user: link.user, mode });
}

/** Name to show for a home device. */
export function routerDeviceLabel(device: RouterDevice): string {
  return device.name || device.hostname || device.mac.toUpperCase();
}

/**
 * Hosts of every server of the account. The router always reaches them
 * directly, so a device running its own ToBeVPN is not tunnelled twice.
 */
function accountServerHosts(): string[] {
  return [...new Set(getCachedVpnServers().map((server) => server.address).filter(Boolean))];
}

/** Subscription address of the account, which the router fetches itself. */
export function accountSubscriptionUrl(): string | null {
  const key = getSession().shortUuid;
  if (!SUBSCRIPTION_BASE_URL || !key) return null;
  try {
    return new URL(encodeURIComponent(key), SUBSCRIPTION_BASE_URL).toString();
  } catch {
    return null;
  }
}
