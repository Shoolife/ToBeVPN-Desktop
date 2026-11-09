// Home router detection for the Router section (Devices screen).
//
// The native side finds the default gateway and reads the router's login
// page, which needs no password. Store builds have no Router section: they
// cannot run SSH or install software on another device.
import { invoke } from "@tauri-apps/api/core";
import type { LinkedDeviceDto } from "../api/types";
import { BOT_API_BASE_URL, PANEL_BASE_URL, SUBSCRIPTION_BASE_URL } from "../api/config";
import { isBrowserPreviewRuntime } from "./browserPreview";
import { getSession } from "./store";
import type { ServerVpnConfig } from "./vpn";
import { fetchDevices, getCachedVpnServers, unlinkOtherDevice } from "./auth";

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
  /** Name the owner gave the router, kept on the router. */
  name: string | null;
  /** The router's device id in the account. */
  hwid: string | null;
  /** Russian sites go around the VPN, as in the app. */
  ruDirect: boolean;
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

/** Tunnels the router agent has: at most this many different servers. */
export const ROUTER_MAX_SERVERS = 8;
/**
 * Free memory counted for a further server. A tunnel process and its Xray
 * connections take about 1-2 MB; the margin keeps the router clear of
 * running out of memory under load.
 */
const SERVER_MEMORY_KB = 6 * 1024;
/** Free memory always left to the router itself and to Xray's peaks. */
const ROUTER_RESERVE_KB = 28 * 1024;

/**
 * How many different servers this router can hold at once: those already on
 * it plus what its free memory still fits, so a stronger router holds more.
 */
export function routerServerLimit(status: RouterStatus, onRouter: number): number {
  const free = status.memoryAvailableKb;
  if (free === null) return Math.min(ROUTER_MAX_SERVERS, Math.max(onRouter, 4));
  const more = Math.max(0, Math.floor((free - ROUTER_RESERVE_KB) / SERVER_MEMORY_KB));
  return Math.min(ROUTER_MAX_SERVERS, Math.max(1, onRouter + more));
}

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
  /** Device id of the router in the account, once its status was read. */
  hwid?: string | null;
  name?: string | null;
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
      hwid: typeof parsed.hwid === "string" ? parsed.hwid : null,
      name: typeof parsed.name === "string" ? parsed.name : null,
    };
  } catch {
    return null;
  }
}

export const ROUTER_CHANGED_EVENT = "tobevpn:router-changed";

function saveRouterLink(link: RouterLink | null): void {
  try {
    if (link) localStorage.setItem(LINK_KEY, JSON.stringify(link));
    else localStorage.removeItem(LINK_KEY);
  } catch {
    // Without storage the router is paired again next time.
  }
  window.dispatchEvent(new Event(ROUTER_CHANGED_EVENT));
}

// Names of every router this app has talked to, by device id: other routers
// of the account are shown with them on the Devices screen. The name lives on
// the router; the panel only knows the model.
const NAMES_KEY = "tobevpn_router_names_v1";

function readNames(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function routerNameFor(hwid: string | null | undefined): string | null {
  if (!hwid) return null;
  const name = readNames()[hwid];
  return typeof name === "string" && name ? name : null;
}

/** Keeps the link and the name list in step with what the router reported. */
function remember(link: RouterLink, status: RouterStatus): void {
  if (status.hwid) {
    try {
      const names = readNames();
      if (status.name) names[status.hwid] = status.name;
      else delete names[status.hwid];
      localStorage.setItem(NAMES_KEY, JSON.stringify(names));
    } catch {
      // The name is shown again after the next status.
    }
  }
  if (link.hwid !== status.hwid || link.name !== status.name) {
    saveRouterLink({ ...link, hwid: status.hwid, name: status.name });
  }
}

/** Name to show: the owner's name, else the model. */
export function routerDisplayName(link: RouterLink | null, info: RouterInfo | null): string | null {
  return link?.name || info?.model || null;
}

/** Russian sites around the VPN on the router, for every device on VPN; restarts the VPN. */
export async function setRouterRuDirect(link: RouterLink, enabled: boolean): Promise<RouterStatus> {
  const status = await invoke<RouterStatus>("router_set_ru_direct", { host: link.host, user: link.user, enabled });
  remember(getRouterLink() ?? link, status);
  return status;
}

export async function setRouterName(link: RouterLink, name: string): Promise<RouterStatus> {
  const status = await invoke<RouterStatus>("router_set_name", { host: link.host, user: link.user, name });
  remember(getRouterLink() ?? link, status);
  return status;
}

// ------------------------------------------------------------- traffic ---

/** VPN traffic of the whole home network through the router, by hour. */
export interface RouterTrafficHour {
  /** Epoch seconds of the hour's start. */
  hour: number;
  bytes: number;
}

const TRAFFIC_KEY = "tobevpn_router_traffic_v1";
export const ROUTER_TRAFFIC_EVENT = "tobevpn:router-traffic";
/** Fired when a read of the router's traffic starts and ends. */
export const ROUTER_TRAFFIC_LOADING_EVENT = "tobevpn:router-traffic-loading";

let trafficLoading = false;

export function isRouterTrafficLoading(): boolean {
  return trafficLoading;
}

function setTrafficLoading(loading: boolean): void {
  trafficLoading = loading;
  window.dispatchEvent(new Event(ROUTER_TRAFFIC_LOADING_EVENT));
}

interface TrafficCache {
  hwid: string | null;
  fetchedAt: number;
  hours: RouterTrafficHour[];
}

export function getCachedRouterTraffic(): RouterTrafficHour[] {
  const link = getRouterLink();
  if (!link) return [];
  try {
    const cache = JSON.parse(localStorage.getItem(TRAFFIC_KEY) ?? "null") as TrafficCache | null;
    if (!cache || !Array.isArray(cache.hours) || (cache.hwid && link.hwid && cache.hwid !== link.hwid)) return [];
    return cache.hours;
  } catch {
    return [];
  }
}

let trafficInFlight: Promise<void> | null = null;

/**
 * Reads the router's traffic when the cached copy is older than `maxAgeMs`.
 * Silent on failure (another network, router off): the cache stays.
 */
export function refreshRouterTraffic(maxAgeMs = 5 * 60_000): Promise<void> {
  const link = getRouterLink();
  if (!link || !ROUTER_SECTION_AVAILABLE || isBrowserPreviewRuntime()) return Promise.resolve();
  try {
    const cache = JSON.parse(localStorage.getItem(TRAFFIC_KEY) ?? "null") as TrafficCache | null;
    if (cache && Date.now() - cache.fetchedAt < maxAgeMs && (!link.hwid || cache.hwid === link.hwid)) {
      return Promise.resolve();
    }
  } catch {
    // Read it again below.
  }
  if (trafficInFlight) return trafficInFlight;
  setTrafficLoading(true);
  trafficInFlight = invoke<RouterTrafficHour[]>("router_traffic", { host: link.host, user: link.user })
    .then((hours) => {
      const cache: TrafficCache = { hwid: link.hwid ?? null, fetchedAt: Date.now(), hours };
      try {
        localStorage.setItem(TRAFFIC_KEY, JSON.stringify(cache));
      } catch {
        // Shown until the screen closes.
      }
      window.dispatchEvent(new Event(ROUTER_TRAFFIC_EVENT));
    })
    .catch(() => undefined)
    .finally(() => {
      trafficInFlight = null;
      setTrafficLoading(false);
    });
  return trafficInFlight;
}

/** Bytes through the router between two epoch-second bounds. */
export function routerTrafficBetween(hours: RouterTrafficHour[], startSec: number, endSec: number): number {
  return hours.reduce((sum, item) => (item.hour >= startSec && item.hour < endSec ? sum + item.bytes : sum), 0);
}

/** SSH login of the router's administrator by firmware family. */
export function defaultRouterUser(info: RouterInfo | null): string {
  return info?.firmware === "easywrt" ? "Admin" : "root";
}

/**
 * Pairs with the router (the password is used once and not stored) and
 * installs or updates ToBeVPN on it with the given server.
 */
/** Whether the VPN fits a router: what "Check the router" shows. */
export interface RouterCheck {
  ok: boolean;
  model: string;
  firmware: string;
  machine: string;
  cpuOk: boolean;
  memoryTotalMb: number;
  memoryFreeMb: number;
  spaceFreeMb: number;
  /** "nftables", "iptables" or "none". */
  firewall: string;
  /** Packages the install adds. */
  packages: string[];
  /** "cpu", "memory_total", "memory_free", "space", "packages", "firewall". */
  problems: string[];
}

/**
 * Logs in once with the router password (which installs the app's key and is
 * not stored), then checks the router without changing anything else.
 */
export async function checkRouter(options: { host: string; user: string; password: string }): Promise<RouterCheck> {
  const { host, user, password } = options;
  await invoke("router_pair", { host, user, password });
  return invoke<RouterCheck>("router_check", { host, user });
}

/** The check again, with the app's key: no password needed. */
export async function recheckRouter(host: string, user: string): Promise<RouterCheck> {
  return invoke<RouterCheck>("router_check", { host, user });
}

/** Installs ToBeVPN on a router checked (and so paired) before. */
export async function installRouter(options: {
  host: string;
  user: string;
  server: SlotServer;
  subscriptionUrl: string;
  autostart: boolean;
}): Promise<RouterStatus> {
  const { host, user, server, subscriptionUrl, autostart } = options;
  const serverHosts = accountServerHosts();
  const status = await invoke<RouterStatus>("router_install", {
    host,
    user,
    servers: [{ ...server, slot: 0 }],
    serverHosts,
    subscriptionUrl,
    autostart,
  });
  const link = { host, user, serverId: server.id, serverName: server.name };
  saveRouterLink(link);
  remember(link, status);
  return status;
}

export interface RouterUpdate {
  available: boolean;
  /** "xray", "hev-socks5-tunnel", "agent". */
  components: string[];
  /** Xray on the router and the version it would get. */
  xrayCurrent: string | null;
  xrayTarget: string | null;
}

/** Whether the router runs older components than this app carries. */
export async function routerUpdateCheck(link: RouterLink): Promise<RouterUpdate> {
  return invoke<RouterUpdate>("router_update_check", { host: link.host, user: link.user });
}

/** Brings the router's components up to date; servers and device choices stay. */
export async function updateRouter(link: RouterLink): Promise<RouterStatus> {
  return invoke<RouterStatus>("router_update", { host: link.host, user: link.user });
}

export async function routerStatus(link: RouterLink): Promise<RouterStatus> {
  const status = await invoke<RouterStatus>("router_status", { host: link.host, user: link.user });
  if (status.installed) remember(link, status);
  return status;
}

/**
 * Takes the router's device off the account, so it no longer takes a device
 * of the subscription. Nothing to do when the account does not list it.
 */
export async function unlinkRouterFromAccount(
  hwid: string | null | undefined,
  resetSubscription = true,
): Promise<void> {
  if (!hwid) return;
  const data = await fetchDevices();
  const wanted = hwid.toLowerCase();
  const device = data?.devices.find(
    (item) => (item.hwid ?? "").toLowerCase() === wanted || item.device_id.toLowerCase() === wanted,
  );
  if (device) await unlinkOtherDevice(device.device_id, resetSubscription);
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

/**
 * Reconnects a home device to Wi-Fi for a moment, so it drops DNS answers
 * cached before its VPN changed. False when it is wired or cannot be.
 */
export async function reconnectRouterDevice(link: RouterLink, mac: string): Promise<boolean> {
  return invoke<boolean>("router_kick", { host: link.host, user: link.user, mac });
}

/** Drops this computer's own cached DNS answers. */
export async function flushThisComputerDns(): Promise<boolean> {
  return invoke<boolean>("flush_dns_cache").catch(() => false);
}

export async function setRouterDefaultMode(
  link: RouterLink,
  mode: RouterDeviceMode,
): Promise<RouterStatus> {
  return invoke<RouterStatus>("router_set_default_mode", { host: link.host, user: link.user, mode });
}

// Names home devices announce over UPnP ("[LG] webOS TV UJ630V" where DHCP
// only says "LGwebOSTV"), kept by MAC so a device that is off keeps its name.
const LAN_NAMES_KEY = "tobevpn_router_lan_names_v1";

export function cachedLanNames(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAN_NAMES_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Asks the home network for the names its devices announce, sent from this
 * computer's address there. Returns the names by MAC, merged with earlier ones.
 */
export async function discoverLanNames(
  localIp: string,
  devices: RouterDevice[],
): Promise<Record<string, string>> {
  const names = cachedLanNames();
  if (!ROUTER_SECTION_AVAILABLE || isBrowserPreviewRuntime()) return names;
  const byIp = await invoke<Record<string, { friendlyName: string }>>("lan_device_names", { localIp }).catch(
    () => ({}) as Record<string, { friendlyName: string }>,
  );
  for (const device of devices) {
    const found = device.ip ? byIp[device.ip]?.friendlyName : undefined;
    if (found) names[device.mac] = found;
  }
  try {
    localStorage.setItem(LAN_NAMES_KEY, JSON.stringify(names));
  } catch {
    // Asked again next time.
  }
  return names;
}

/** Name to show for a home device: the owner's, the announced one, DHCP's, the MAC. */
export function routerDeviceLabel(device: RouterDevice, lanNames: Record<string, string> = {}): string {
  return device.name || lanNames[device.mac] || device.hostname || device.mac.toUpperCase();
}

/**
 * Hosts of every server of the account. The router always reaches them
 * directly, so a device running its own ToBeVPN is not tunnelled twice.
 */
function accountServerHosts(): string[] {
  const servers = getCachedVpnServers().map((server) => server.address);
  return [...new Set([...servers, ...serviceHosts()].filter(Boolean))];
}

/**
 * The app's own services (subscription, bot API, panel). The router sends
 * them direct too: the app on a computer behind the router then reaches
 * them as without it, not through a foreign server that may not get to
 * them (its subscription requests timed out that way).
 */
function serviceHosts(): string[] {
  const urls = [SUBSCRIPTION_BASE_URL, PANEL_BASE_URL, BOT_API_BASE_URL, import.meta.env.VITE_BOT_API_URL];
  return urls.flatMap((url) => {
    try {
      return url ? [new URL(url).hostname] : [];
    } catch {
      return [];
    }
  });
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
