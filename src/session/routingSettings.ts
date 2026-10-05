export type RoutingMode = "blocked_only" | "selective" | "all_vpn";

export interface RoutingSettings {
  mode: RoutingMode;
  selectAllServices: boolean;
  selectedServiceDomains: string[];
  excludedServiceDomains: string[];
  directDomains: string[];
  proxyDomains: string[];
}

const STORAGE_KEY = "tobevpn_routing_settings";
const LEGACY_STORAGE_KEYS = [
  "tobevpn_routing_settings_v3",
  "tobevpn_routing_settings_v2",
  "tobevpn_routing_settings_v1",
];
export const MAX_DOMAINS_PER_LIST = 128;
const MAX_SERVICE_DOMAINS = 10_000;

const DEFAULT_SETTINGS: RoutingSettings = {
  mode: "blocked_only",
  selectAllServices: false,
  selectedServiceDomains: [],
  excludedServiceDomains: [],
  directDomains: [],
  proxyDomains: [],
};

function normalizeDomainValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let input = value.trim().toLowerCase();
  if (!input) return null;

  input = input.replace(/^\*\./, "");
  try {
    const parsed = new URL(input.includes("://") ? input : `https://${input}`);
    input = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }

  if (
    input.length > 253 ||
    (!input.includes(".") && input.length < 2) ||
    // An IP address (or a number the URL parser turned into one) would
    // become a domain rule that never matches anything.
    isIpLiteral(input) ||
    input.startsWith(".") ||
    input.endsWith(".") ||
    input.split(".").some(
      (label) =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        !/^[a-z0-9-]+$/.test(label),
    )
  ) {
    return null;
  }
  return input;
}

function isIpLiteral(host: string): boolean {
  return /^\d+$/.test(host.split(".").pop() ?? "") || host.startsWith("[");
}

/** Whether the input is an IP address rather than a site name. */
export function looksLikeIpAddress(value: string): boolean {
  const input = value.trim().toLowerCase();
  if (!input) return false;
  try {
    const parsed = new URL(input.includes("://") ? input : `https://${input}`);
    return isIpLiteral(parsed.hostname);
  } catch {
    return /^[\d.:[\]]+$/.test(input);
  }
}

// --- Display of internationalised names (RFC 3492 punycode) ---

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;

function punyAdapt(delta: number, points: number, first: boolean): number {
  let value = first ? Math.floor(delta / 700) : delta >> 1;
  value += Math.floor(value / points);
  let k = 0;
  while (value > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    value = Math.floor(value / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * value) / (value + 38));
}

function punyDecodeLabel(input: string): string | null {
  const output: number[] = [];
  const basic = input.lastIndexOf("-");
  for (let index = 0; index < Math.max(0, basic); index++) output.push(input.charCodeAt(index));
  let n = 128;
  let i = 0;
  let bias = 72;
  let position = basic > 0 ? basic + 1 : 0;
  while (position < input.length) {
    const old = i;
    let weight = 1;
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (position >= input.length) return null;
      const code = input.charCodeAt(position++);
      const digit = code - 48 < 10 ? code - 22 : code - 97 < 26 ? code - 97 : code - 65 < 26 ? code - 65 : PUNY_BASE;
      if (digit >= PUNY_BASE) return null;
      i += digit * weight;
      const threshold = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
      if (digit < threshold) break;
      weight *= PUNY_BASE - threshold;
      if (weight > 0x7fffffff) return null;
    }
    bias = punyAdapt(i - old, output.length + 1, old === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...output);
}

/** A stored (punycode) domain as people write it: xn--p1ai -> рф. */
export function displayRoutingDomain(domain: string): string {
  return domain
    .split(".")
    .map((label) => (label.startsWith("xn--") ? punyDecodeLabel(label.slice(4)) ?? label : label))
    .join(".");
}

function normalizeDomainList(value: unknown, limit = MAX_DOMAINS_PER_LIST): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const domain = normalizeDomainValue(item);
    if (domain) out.add(domain);
    if (out.size >= limit) break;
  }
  return [...out].sort();
}

function normalizeRoutingMode(value: unknown): RoutingMode {
  switch (value) {
    case "all_vpn":
    case "allVpn":
      return "all_vpn";
    case "selective":
      return "selective";
    case "blocked_only":
    case "automatic":
    case "auto":
    default:
      return "blocked_only";
  }
}

function firstArray(...values: unknown[]): unknown {
  return values.find((value) => Array.isArray(value));
}

function normalizeSettings(value: unknown): RoutingSettings {
  const parsed =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const proxyDomains = normalizeDomainList(
    firstArray(
      parsed.proxyDomains,
      parsed.alwaysVpnDomains,
      parsed.vpnDomains,
      parsed.proxyDomainExceptions,
    ),
  );
  const proxySet = new Set(proxyDomains);
  return {
    mode: normalizeRoutingMode(parsed.mode),
    selectAllServices:
      parsed.selectAllServices === true ||
      parsed.selectAllRuServices === true ||
      parsed.selectAllDomains === true,
    selectedServiceDomains: normalizeDomainList(
      firstArray(
        parsed.selectedServiceDomains,
        parsed.selectedDomains,
        parsed.directServiceDomains,
        parsed.ruServiceDomains,
      ),
      MAX_SERVICE_DOMAINS,
    ),
    excludedServiceDomains: normalizeDomainList(
      firstArray(
        parsed.excludedServiceDomains,
        parsed.excludedDomains,
        parsed.excludedRuDomains,
      ),
      MAX_SERVICE_DOMAINS,
    ),
    directDomains: normalizeDomainList(
      firstArray(
        parsed.directDomains,
        parsed.alwaysDirectDomains,
        parsed.bypassDomains,
        parsed.directDomainExceptions,
      ),
    ).filter((domain) => !proxySet.has(domain)),
    proxyDomains,
  };
}

function readStoredSettings(): { settings: RoutingSettings; shouldPersist: boolean } | null {
  const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      return {
        settings: normalizeSettings(JSON.parse(raw)),
        shouldPersist: key !== STORAGE_KEY,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function normalizeRoutingDomain(value: string): string | null {
  return normalizeDomainValue(value);
}

export function loadRoutingSettings(): RoutingSettings {
  try {
    const stored = readStoredSettings();
    if (!stored) return { ...DEFAULT_SETTINGS };
    if (stored.shouldPersist) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored.settings));
    }
    return stored.settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Whether `domain` is `parent` itself or one of its subdomains. */
export function isWithinDomain(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * The service lists sent to the VPN core in "Selective" mode. Xray applies
 * them most-specific-first (config.rs), so besides the stored choice it needs
 * the entries whose state differs from a zone that contains them:
 * - one by one: the checked domains, plus every unchecked domain inside a
 *   checked zone (unchecked "sberbank.ru" under checked "ru");
 * - "select all": the excluded domains, plus every checked domain inside an
 *   excluded zone (all other services come from the geosite groups).
 * Without the database the stored lists are sent as they are.
 */
export function serviceRoutingLists(
  settings: RoutingSettings,
  database: string[] | null,
): { selected: string[]; excluded: string[] } {
  if (settings.selectAllServices) {
    const excluded = settings.excludedServiceDomains;
    const excludedSet = new Set(excluded);
    const selected = (database ?? []).filter(
      (domain) =>
        !excludedSet.has(domain) && excluded.some((zone) => zone !== domain && isWithinDomain(domain, zone)),
    );
    return { selected, excluded };
  }
  const selected = settings.selectedServiceDomains;
  const selectedSet = new Set(selected);
  const excluded = (database ?? []).filter(
    (domain) =>
      !selectedSet.has(domain) && selected.some((zone) => zone !== domain && isWithinDomain(domain, zone)),
  );
  return { selected, excluded };
}

export function saveRoutingSettings(settings: RoutingSettings): RoutingSettings {
  const normalized = normalizeSettings(settings);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}
