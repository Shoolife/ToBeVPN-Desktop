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
const MAX_DOMAINS_PER_LIST = 128;

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
    input.startsWith(".") ||
    input.endsWith(".") ||
    input.split(".").some((label) => !label || label.length > 63)
  ) {
    return null;
  }
  return input;
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
      100_000,
    ),
    excludedServiceDomains: normalizeDomainList(
      firstArray(
        parsed.excludedServiceDomains,
        parsed.excludedDomains,
        parsed.excludedRuDomains,
      ),
      100_000,
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

export function saveRoutingSettings(settings: RoutingSettings): RoutingSettings {
  const normalized = normalizeSettings(settings);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}
