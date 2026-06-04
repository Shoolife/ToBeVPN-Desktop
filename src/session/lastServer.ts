// Persists the last server the user picked so it's pre-selected on next launch.
// VPN is not auto-started — only the selection is restored.
import type { SelectedServer } from "../App";
import { getSession } from "./store";

const STORAGE_KEY = "tobevpn_last_server_v2";
const LEGACY_STORAGE_KEY = "tobevpn_last_server_v1";
const AUTOMATIC_STORAGE_KEY = "tobevpn_automatic_server_selection_v1";
const SERVER_SELECTION_EVENT = "tobevpn:server-selection-changed";

interface StoredLastServer {
  ownerKey: string;
  server: SelectedServer;
}

interface StoredAutomaticSelection {
  ownerKey: string;
  automatic: boolean;
}

function isSelectedServer(value: unknown): value is SelectedServer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.country === "string" &&
    typeof candidate.address === "string" &&
    typeof candidate.port === "number" &&
    typeof candidate.uuid === "string" &&
    typeof candidate.flow === "string" &&
    typeof candidate.security === "string" &&
    typeof candidate.sni === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.public_key === "string" &&
    typeof candidate.short_id === "string" &&
    typeof candidate.network === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.mode === "string" &&
    typeof candidate.spx === "string"
  );
}

function ownerKeyForShortUuid(shortUuid: string | null): string | null {
  if (!shortUuid) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < shortUuid.length; i++) {
    hash ^= shortUuid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function currentOwnerKey(): string | null {
  return ownerKeyForShortUuid(getSession().shortUuid);
}

function isStoredLastServer(value: unknown): value is StoredLastServer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ownerKey === "string" &&
    isSelectedServer(candidate.server)
  );
}

export function loadLastServer(): SelectedServer | null {
  try {
    const ownerKey = currentOwnerKey();
    if (!ownerKey) {
      return null;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (isStoredLastServer(parsed) && parsed.ownerKey === ownerKey) {
        return parsed.server;
      }
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // v1 did not store the subscription owner. Drop it on upgrade instead of
    // risking a stale server from a previous trial/account.
    if (localStorage.getItem(LEGACY_STORAGE_KEY)) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

export function saveLastServer(server: SelectedServer) {
  try {
    const ownerKey = currentOwnerKey();
    if (!ownerKey) return;
    const automatic = loadAutomaticServerSelection();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ownerKey, server }));
    localStorage.setItem(
      AUTOMATIC_STORAGE_KEY,
      JSON.stringify({ ownerKey, automatic } satisfies StoredAutomaticSelection),
    );
    window.dispatchEvent(new Event(SERVER_SELECTION_EVENT));
  } catch {
    // ignore
  }
}

export function loadAutomaticServerSelection(): boolean {
  try {
    const ownerKey = currentOwnerKey();
    if (!ownerKey) return true;
    const raw = localStorage.getItem(AUTOMATIC_STORAGE_KEY);
    if (!raw) {
      // Existing users with a persisted server keep their explicit manual
      // selection. New users start in AUTO.
      return loadLastServer() === null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredAutomaticSelection>;
    if (parsed.ownerKey === ownerKey && typeof parsed.automatic === "boolean") {
      return parsed.automatic;
    }
    localStorage.removeItem(AUTOMATIC_STORAGE_KEY);
    return loadLastServer() === null;
  } catch {
    return loadLastServer() === null;
  }
}

export function saveAutomaticServerSelection(automatic: boolean): void {
  try {
    const ownerKey = currentOwnerKey();
    if (!ownerKey) return;
    localStorage.setItem(
      AUTOMATIC_STORAGE_KEY,
      JSON.stringify({ ownerKey, automatic } satisfies StoredAutomaticSelection),
    );
    window.dispatchEvent(new Event(SERVER_SELECTION_EVENT));
  } catch {
    // ignore
  }
}

export function subscribeServerSelection(listener: () => void): () => void {
  window.addEventListener(SERVER_SELECTION_EVENT, listener);
  return () => window.removeEventListener(SERVER_SELECTION_EVENT, listener);
}

export function clearSelectedServer(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    window.dispatchEvent(new Event(SERVER_SELECTION_EVENT));
  } catch {
    // ignore
  }
}

export function clearLastServer() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(AUTOMATIC_STORAGE_KEY);
    window.dispatchEvent(new Event(SERVER_SELECTION_EVENT));
  } catch {
    // ignore
  }
}
