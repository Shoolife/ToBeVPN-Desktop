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
  /**
   * ToBeVPN's mark on the router (a hash of its device id in the account),
   * read without logging in; null without ToBeVPN or with an older agent.
   */
  mark?: string | null;
}

/** The marks ToBeVPN routers with these device ids publish. */
export async function routerMarks(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return invoke<string[]>("router_marks", { ids }).catch(() => ids.map(() => ""));
}

/**
 * Whether the linked router is the router of this network: the same address,
 * and, when the router publishes its mark, the same router (a cottage on
 * 192.168.1.1 too is another one).
 */
export async function isLinkedRouterHere(link: RouterLink, info: RouterInfo | null): Promise<boolean> {
  if (!info?.gateway || info.gateway !== link.host) return false;
  if (!info.mark || !link.hwid) return true;
  // The router itself just showed this link's host key: it is this one,
  // whatever kind of mark it publishes (an older agent: SHA-256).
  const scan = scannedKey;
  if (scan && scan.host === link.host && link.hostKey && scan.key === link.hostKey && Date.now() - scan.at < SCAN_VALID_MS) {
    return true;
  }
  const [mark] = await routerMarks([link.hwid]);
  return mark === info.mark;
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
  /** This entry in the list of connected routers. */
  id?: string;
  /** The mark the router publishes (from its device id), to tell it apart. */
  mark?: string | null;
  /** The router's SSH host key: commands for this link reach only this router. */
  hostKey?: string | null;
  /** How `mark` was computed (marks of another kind are dropped). */
  markAlgo?: string;
}

/**
 * A command for one connected router. Its host key is pinned first, so with
 * several routers paired at one address (home and a cottage) the command
 * reaches this one or fails, never the other.
 */
async function linkInvoke<T = void>(link: RouterLink, command: string, args: Record<string, unknown> = {}): Promise<T> {
  // The key travels with the command (no shared state another call could
  // change in between), taken from the saved entry: a screen's older copy of
  // the link may not know it yet.
  const fingerprint = storedLink(link).hostKey ?? null;
  return invoke<T>(command, { host: link.host, user: link.user, fingerprint, ...args });
}

// Every router this computer is connected to (home, a cottage…), most
// recently connected first. Each keeps its own key on the router and its
// own pinned host key here, so moving between them needs no password.
const LINKS_KEY = "tobevpn_router_links_v1";
/** The single link earlier versions kept. */
const LINK_KEY = "tobevpn_router_v1";

/** How the saved marks were computed; others are dropped on reading. */
const MARK_ALGO = "md5";

function parseLink(value: unknown): RouterLink | null {
  const parsed = value as Partial<RouterLink> | null;
  if (!parsed || typeof parsed.host !== "string" || typeof parsed.user !== "string") return null;
  return {
    host: parsed.host,
    user: parsed.user,
    serverId: typeof parsed.serverId === "string" ? parsed.serverId : null,
    serverName: typeof parsed.serverName === "string" ? parsed.serverName : null,
    hwid: typeof parsed.hwid === "string" ? parsed.hwid : null,
    name: typeof parsed.name === "string" ? parsed.name : null,
    id: typeof parsed.id === "string" ? parsed.id : newLinkId(),
    // Marks saved before they became MD5 (SNR firmware has no sha256sum) no
    // longer match the router's: dropped, and computed again on next save.
    mark: typeof parsed.mark === "string" && parsed.markAlgo === MARK_ALGO ? parsed.mark : null,
    markAlgo: MARK_ALGO,
    hostKey: typeof parsed.hostKey === "string" ? parsed.hostKey : null,
  };
}

function newLinkId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readLinks(): RouterLink[] {
  try {
    const raw = localStorage.getItem(LINKS_KEY);
    let links: RouterLink[];
    let fresh = false;
    if (raw) {
      const list = JSON.parse(raw) as unknown;
      links = Array.isArray(list) ? list.map(parseLink).filter((link): link is RouterLink => !!link) : [];
      fresh = Array.isArray(list) && list.some((item) => typeof (item as { id?: unknown })?.id !== "string");
    } else {
      const single = parseLink(JSON.parse(localStorage.getItem(LINK_KEY) ?? "null"));
      links = single ? [single] : [];
      fresh = links.length > 0;
    }
    // Ids given just now are kept, so an entry is the same one on every read
    // (and the old single link moves to the list once).
    if (fresh) {
      localStorage.setItem(LINKS_KEY, JSON.stringify(links));
      localStorage.removeItem(LINK_KEY);
    }
    return links;
  } catch {
    return [];
  }
}

function writeLinks(links: RouterLink[]): void {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(links));
    localStorage.removeItem(LINK_KEY);
  } catch {
    // Without storage the router is paired again next time.
  }
  window.dispatchEvent(new Event(ROUTER_CHANGED_EVENT));
}

/**
 * The connected router of the current network: at this address and, when
 * the router shows its mark, that very router (home and a cottage can both
 * be 192.168.1.1); without a mark, the one connected last at the address.
 */
export function getRouterLink(): RouterLink | null {
  const links = readLinks();
  const info = cached;
  if (!info?.gateway) return links[0] ?? null;
  const here = links.filter((link) => link.host === info.gateway);
  // The router's own mark first (exact), then the host key the address
  // showed a moment ago (identifyRouterHere), then a loose guess.
  if (info.mark) {
    const byMark = here.find((link) => link.mark === info.mark);
    if (byMark) return byMark;
  }
  const scan = scannedKey;
  if (scan && scan.host === info.gateway && Date.now() - scan.at < SCAN_VALID_MS) {
    const byKey = here.find((link) => link.hostKey === scan.key);
    if (byKey) return byKey;
  }
  if (!info.mark) return here[0] ?? null;
  // The entry that is this router; else the most recent one that may be
  // (its id or mark not known yet: just paired, e.g. again after a reset —
  // then its old entry is dropped once the id is read).
  return here.find((link) => link.mark === info.mark) ?? here.find((link) => !link.hwid || !link.mark) ?? null;
}

export const ROUTER_CHANGED_EVENT = "tobevpn:router-changed";

let scannedKey: { host: string; key: string; at: number } | null = null;
/** A scanned host key speaks for the address this long. */
const SCAN_VALID_MS = 5 * 60_000;

/**
 * With several routers connected at this network's address, asks the router
 * there for its host key (key exchange only, no login), so getRouterLink
 * picks the one actually answering. Nothing to ask with one or none.
 */
export async function identifyRouterHere(info: RouterInfo | null): Promise<void> {
  const gateway = info?.gateway;
  if (!gateway) return;
  let here = readLinks().filter((link) => link.host === gateway);
  // Marks missing (dropped as outdated, never read) are computed first, so
  // the router's own mark can pick its link.
  const unmarked = here.filter((link) => link.hwid && !link.mark);
  if (unmarked.length > 0) {
    const marks = await routerMarks(unmarked.map((link) => link.hwid as string));
    unmarked.forEach((link, index) => {
      if (marks[index]) updateRouterLink(link, { mark: marks[index], markAlgo: MARK_ALGO });
    });
    here = readLinks().filter((link) => link.host === gateway);
  }
  const markMatches = !!info?.mark && here.some((link) => link.mark === info.mark);
  // The host key is asked when the mark does not settle it: several routers
  // at the address, or one whose mark is of another kind (an older agent).
  const keyed = here.filter((link) => link.hostKey);
  if (markMatches || keyed.length === 0 || (here.length < 2 && !info?.mark)) {
    scannedKey = null;
    return;
  }
  // A fresh answer for this address is reused (no key exchange each minute).
  if (scannedKey && scannedKey.host === gateway && Date.now() - scannedKey.at < SCAN_VALID_MS) return;
  const key = await invoke<string | null>("router_host_key", { host: gateway }).catch(() => null);
  scannedKey = key ? { host: gateway, key, at: Date.now() } : null;
}

/**
 * Saves a connected router: its entry is replaced (or added first), and an
 * older entry of the same router (connected again) is dropped.
 */
function saveRouterLink(link: RouterLink): RouterLink {
  const entry: RouterLink = { ...link, id: link.id ?? newLinkId() };
  let links = readLinks().filter((item) => item.id !== entry.id);
  if (!entry.hwid) links = links.filter((item) => !(item.host === entry.host && !item.hwid));
  if (entry.hwid) {
    const hwid = entry.hwid.toLowerCase();
    // The same router, or its entry from before its id was read.
    links = links.filter(
      (item) =>
        (item.hwid ?? "").toLowerCase() !== hwid && !(item.host === entry.host && item.user === entry.user && !item.hwid),
    );
  }
  writeLinks([entry, ...links]);
  if (entry.hwid && !entry.mark) {
    void routerMarks([entry.hwid]).then(([mark]) => {
      if (!mark) return;
      const list = readLinks();
      const index = list.findIndex((item) => item.id === entry.id);
      if (index < 0) return;
      list[index] = { ...list[index], mark, markAlgo: MARK_ALGO };
      writeLinks(list);
    });
  }
  return entry;
}

/** The saved entry of a link (a screen may hold an older copy of it). */
function storedLink(link: RouterLink): RouterLink {
  return readLinks().find((item) => item.id && item.id === link.id) ?? link;
}

/**
 * Changes some fields of a connected router, on its saved entry: what a
 * screen's older copy of the link does not know (a name set from the phone,
 * a mark, a host key) is kept.
 */
function updateRouterLink(link: RouterLink, patch: Partial<RouterLink>): void {
  // A link forgotten meanwhile (removed on uninstall) is not brought back.
  const stored = readLinks().find((item) => item.id && item.id === link.id);
  if (!stored) return;
  saveRouterLink({ ...stored, ...patch });
}

/** Forgets one connected router; the others stay. */
function removeRouterLink(link: RouterLink): void {
  writeLinks(readLinks().filter((item) => item.id !== link.id));
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
  const stored = storedLink(link);
  if (stored.hwid !== status.hwid || stored.name !== status.name) {
    updateRouterLink(link, { hwid: status.hwid, name: status.name, mark: stored.hwid === status.hwid ? stored.mark : null });
  }
}

/** Name to show: the owner's name, else the model. */
export function routerDisplayName(link: RouterLink | null, info: RouterInfo | null): string | null {
  return link?.name || info?.model || null;
}

/** Russian sites around the VPN on the router, for every device on VPN; restarts the VPN. */
export async function setRouterRuDirect(link: RouterLink, enabled: boolean): Promise<RouterStatus> {
  const status = await linkInvoke<RouterStatus>(link, "router_set_ru_direct", { enabled });
  // The link acted on, not whichever the network picks now.
  remember(link, status);
  return status;
}

export async function setRouterName(link: RouterLink, name: string): Promise<RouterStatus> {
  const status = await linkInvoke<RouterStatus>(link, "router_set_name", { name });
  // The link acted on, not whichever the network picks now.
  remember(link, status);
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

/** Whether this computer is connected to any router (wherever it is now). */
export function hasRouterLinks(): boolean {
  return readLinks().length > 0;
}

/**
 * The traffic read last, of a router still connected: shown on any network
 * (the totals do not change with where the computer is), read only at home.
 */
export function getCachedRouterTraffic(): RouterTrafficHour[] {
  const links = readLinks();
  if (links.length === 0) return [];
  try {
    const cache = JSON.parse(localStorage.getItem(TRAFFIC_KEY) ?? "null") as TrafficCache | null;
    if (!cache || !Array.isArray(cache.hours)) return [];
    if (cache.hwid && !links.some((link) => (link.hwid ?? "").toLowerCase() === cache.hwid?.toLowerCase())) return [];
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
export async function refreshRouterTraffic(maxAgeMs = 5 * 60_000): Promise<void> {
  if (!ROUTER_SECTION_AVAILABLE || isBrowserPreviewRuntime()) return;
  // Only from a connected router's own network, and only that router: the
  // network is known first (not guessed from the last connected router).
  const here = getCachedRouter() ?? (await detectRouter());
  await identifyRouterHere(here);
  const link = getRouterLink();
  if (!link || !(await isLinkedRouterHere(link, here))) return;
  return readRouterTraffic(link, maxAgeMs);
}

function readRouterTraffic(link: RouterLink, maxAgeMs: number): Promise<void> {
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
  trafficInFlight = linkInvoke<RouterTrafficHour[]>(link, "router_traffic", {})
    .then((hours) => storeRouterTraffic(link, hours))
    .catch(() => undefined)
    .finally(() => {
      trafficInFlight = null;
      setTrafficLoading(false);
    });
  return trafficInFlight;
}

/** Keeps a fresh read of the router's traffic and tells the screens. */
function storeRouterTraffic(link: RouterLink, hours: RouterTrafficHour[]): void {
  const cache: TrafficCache = { hwid: link.hwid ?? null, fetchedAt: Date.now(), hours };
  try {
    localStorage.setItem(TRAFFIC_KEY, JSON.stringify(cache));
  } catch {
    // Shown until the screen closes.
  }
  window.dispatchEvent(new Event(ROUTER_TRAFFIC_EVENT));
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
  pairedKeys.set(host, await invoke<string | null>("router_pair", { host, user, password }));
  return invoke<RouterCheck>("router_check", { host, user, fingerprint: pairedKeys.get(host) ?? null });
}

/**
 * This network's router has no link here, but it may still take this
 * computer's key (the link was forgotten, the app reinstalled with its data
 * kept): tried with the usual logins and, if ToBeVPN runs there, connected
 * again without the password. Null when that does not work.
 */
export async function reconnectWithAppKey(info: RouterInfo): Promise<RouterLink | null> {
  const host = info.gateway;
  if (!host || readLinks().some((link) => link.host === host)) return null;
  const users = Array.from(new Set([defaultRouterUser(info), "root"]));
  for (const user of users) {
    try {
      const snapshot = await invoke<RouterSnapshot>("router_snapshot", { host, user, fingerprint: null });
      if (!snapshot.status.installed) return null;
      const link: RouterLink = { host, user, serverId: null, serverName: null, hostKey: snapshot.hostKey };
      const saved = saveRouterLink(link);
      remember(saved, snapshot.status);
      return saved;
    } catch {
      // Not this login, or the key is not on the router: the password then.
    }
  }
  return null;
}

/** The host key each router showed when paired, for the link the install creates. */
const pairedKeys = new Map<string, string | null>();

/**
 * Logs in once and puts the app's key on the router. A router that already
 * runs ToBeVPN (installed from another device) is then simply taken over:
 * it is remembered as this app's router and its status returned, with no
 * install. Otherwise the status says it is not installed.
 */
export async function connectRouter(options: { host: string; user: string; password: string }): Promise<RouterStatus> {
  const { host, user, password } = options;
  const hostKey = await invoke<string | null>("router_pair", { host, user, password });
  pairedKeys.set(host, hostKey);
  const status = await invoke<RouterStatus>("router_status", { host, user, fingerprint: hostKey });
  if (status.installed) {
    const link: RouterLink = { host, user, serverId: null, serverName: null, hostKey };
    const saved = saveRouterLink(link);
    remember(saved, status);
  }
  return status;
}

/**
 * The account lists a router by the model it reports itself, which can be
 * written differently from its login page ("SNR SNR-CPE-AX2" against
 * "SNR-CPE-AX2"): compared by letters and digits, one within the other.
 */
export function sameRouterModel(listed: string, here: string | null | undefined): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(listed);
  const b = norm(here ?? "");
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
}

/**
 * Router models of the account's routers: one of them answering here means
 * ToBeVPN already runs on this router, set up from another device.
 */
export async function accountRouters(): Promise<Array<{ id: string; model: string }>> {
  try {
    const data = await fetchDevices();
    return (data?.devices ?? [])
      .filter(isRouterDevice)
      .map((device) => ({ id: device.hwid || device.device_id, model: (device.device_model ?? "").trim() }));
  } catch {
    return [];
  }
}

/**
 * Whether the account already has this network's router: by its mark when
 * it publishes one (exact, even for two routers of one model), else by model.
 */
export async function accountHasRouterHere(info: RouterInfo): Promise<boolean> {
  // Without a mark the router has no current ToBeVPN; a model match would
  // only confuse two routers of one model.
  if (!info.mark) return false;
  const routers = await accountRouters();
  const marks = await routerMarks(routers.map((router) => router.id));
  return marks.includes(info.mark);
}

/** The check again, with the app's key: no password needed. */
export async function recheckRouter(host: string, user: string): Promise<RouterCheck> {
  return invoke<RouterCheck>("router_check", { host, user, fingerprint: pairedKeys.get(host) ?? null });
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
    fingerprint: pairedKeys.get(host) ?? null,
    servers: [{ ...server, slot: 0 }],
    serverHosts,
    subscriptionUrl,
    autostart,
  });
  const link: RouterLink = {
    host,
    user,
    serverId: server.id,
    serverName: server.name,
    hostKey: pairedKeys.get(host) ?? null,
  };
  const saved = saveRouterLink(link);
  remember(saved, status);
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
  return linkInvoke<RouterUpdate>(link, "router_update_check", {});
}

/** Brings the router's components up to date; servers and device choices stay. */
export async function updateRouter(link: RouterLink): Promise<RouterStatus> {
  return linkInvoke<RouterStatus>(link, "router_update", {});
}

/** Everything the Router screen shows, read in one login. */
export interface RouterSnapshot {
  status: RouterStatus;
  hostKey: string | null;
  network: RouterNetwork | null;
  traffic: RouterTrafficHour[] | null;
}

/**
 * The router's status and, with ToBeVPN on it, its home devices and traffic
 * in one SSH session (instead of one login per question). The traffic is
 * kept as a separate read would keep it.
 */
export async function routerSnapshot(link: RouterLink): Promise<RouterSnapshot> {
  const snapshot = await linkInvoke<RouterSnapshot>(link, "router_snapshot", {});
  const status = snapshot.status;
  if (link.hwid && status.hwid && link.hwid.toLowerCase() !== status.hwid.toLowerCase()) {
    throw new Error("another router at this address");
  }
  if (status.installed) remember(link, status);
  // A link from before host keys were pinned learns its router's key now
  // (its id was just checked above).
  if (snapshot.hostKey && !storedLink(link).hostKey && status.installed) {
    updateRouterLink(link, { hostKey: snapshot.hostKey });
  } else if (status.installed && status.hwid && !storedLink(link).mark) {
    // A mark dropped as outdated is computed again (saving does it).
    updateRouterLink(link, {});
  }
  // Kept under the id the router reported (a just-paired link has none yet).
  if (snapshot.traffic) storeRouterTraffic({ ...link, hwid: status.hwid ?? link.hwid }, snapshot.traffic);
  return snapshot;
}

/** Earlier versions' "default" devices keep the router's server, in one login; the default becomes direct. */
export async function migrateRouterDefaults(
  link: RouterLink,
  devices: Array<{ mac: string; name: string; slot: number }>,
): Promise<RouterStatus> {
  return linkInvoke<RouterStatus>(link, "router_migrate_defaults", {
    devices: devices.map((device) => [device.mac, device.name, device.slot]),
  });
}

const UPDATE_CHECK_EVERY_MS = 30 * 60_000;
const updateChecks = new Map<string, { at: number; result: RouterUpdate }>();

/**
 * The update check at most every half hour per router: it logs in and may
 * ask GitHub. The last answer is given meanwhile.
 */
export async function routerUpdateCheckCached(link: RouterLink): Promise<RouterUpdate> {
  const key = link.id ?? link.host;
  const last = updateChecks.get(key);
  if (last && Date.now() - last.at < UPDATE_CHECK_EVERY_MS) return last.result;
  const result = await routerUpdateCheck(link);
  updateChecks.set(key, { at: Date.now(), result });
  return result;
}

/** After an update the next check is a fresh one. */
export function forgetRouterUpdateCheck(link: RouterLink): void {
  updateChecks.delete(link.id ?? link.host);
}

export async function routerStatus(link: RouterLink): Promise<RouterStatus> {
  const status = await linkInvoke<RouterStatus>(link, "router_status", {});
  // Another router at the linked address (paired elsewhere, no mark to tell
  // them apart before logging in): not the linked one, and its id must not
  // replace the linked router's.
  if (link.hwid && status.hwid && link.hwid.toLowerCase() !== status.hwid.toLowerCase()) {
    throw new Error("another router at this address");
  }
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
  const status = await linkInvoke<RouterStatus>(link, "router_control", {
    action,
  });
  if (action === "uninstall") removeRouterLink(link);
  return status;
}

/** Sets the router's server (slot 0) and the servers of single devices; restarts the tunnels. */
export async function setRouterServers(link: RouterLink, servers: SlotServer[]): Promise<RouterStatus> {
  const main = servers.find((server) => server.slot === 0);
  if (!main) throw new Error("the router server is missing");
  const status = await linkInvoke<RouterStatus>(link, "router_set_servers", {
    servers,
    serverHosts: accountServerHosts(),
  });
  updateRouterLink(link, { serverId: main.id, serverName: main.name });
  return status;
}

export async function routerDevices(link: RouterLink): Promise<RouterNetwork> {
  return linkInvoke<RouterNetwork>(link, "router_devices", {});
}

export async function setRouterDevice(
  link: RouterLink,
  device: { mac: string; mode: RouterDevice["mode"]; slot: number; name: string },
): Promise<void> {
  await linkInvoke(link, "router_set_device", { ...device });
}

/**
 * Reconnects a home device to Wi-Fi for a moment, so it drops DNS answers
 * cached before its VPN changed. False when it is wired or cannot be.
 */
export async function reconnectRouterDevice(link: RouterLink, mac: string): Promise<boolean> {
  return linkInvoke<boolean>(link, "router_kick", { mac });
}

/** Drops this computer's own cached DNS answers. */
export async function flushThisComputerDns(): Promise<boolean> {
  return invoke<boolean>("flush_dns_cache").catch(() => false);
}

export async function setRouterDefaultMode(
  link: RouterLink,
  mode: RouterDeviceMode,
): Promise<RouterStatus> {
  return linkInvoke<RouterStatus>(link, "router_set_default_mode", { mode });
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
