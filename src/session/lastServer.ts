// Keeps the full selected server (including its VLESS credential) in memory
// only. Persisting it in WebView localStorage lets any same-user process clone
// VPN access. The non-secret AUTO preference may still be persisted.
import type { SelectedServer } from "../App";
import { getSession } from "./store";

const STORAGE_KEY = "tobevpn_last_server_v2";
const LEGACY_STORAGE_KEY = "tobevpn_last_server_v1";
const AUTOMATIC_STORAGE_KEY = "tobevpn_automatic_server_selection_v1";
const SERVER_SELECTION_EVENT = "tobevpn:server-selection-changed";

interface StoredAutomaticSelection {
  ownerKey: string;
  automatic: boolean;
}

let memorySelection: { ownerKey: string; server: SelectedServer } | null = null;

function removeLegacyServerSecrets(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

removeLegacyServerSecrets();

function currentMemoryOwnerKey(): string | null {
  const session = getSession();
  if (!session.isLinked || session.telegramId === null || !session.shortUuid) return null;
  // This key never leaves process memory. Use the complete identity instead of
  // a collision-prone 32-bit hash so one session can never inherit another
  // account's VLESS credential.
  return JSON.stringify([
    session.deviceId,
    session.telegramId,
    session.shortUuid,
    session.panelUserUuid ?? "",
  ]);
}

function currentPreferenceOwnerKey(): string | null {
  const session = getSession();
  if (!session.isLinked || session.telegramId === null) return null;
  // Both values are already part of the non-secret session metadata. Do not
  // persist shortUuid or panelUserUuid merely to scope a boolean preference.
  return JSON.stringify([session.deviceId, session.telegramId]);
}

export function loadLastServer(): SelectedServer | null {
  const ownerKey = currentMemoryOwnerKey();
  if (!ownerKey || memorySelection?.ownerKey !== ownerKey) return null;
  return memorySelection.server;
}

export function saveLastServer(server: SelectedServer): void {
  const ownerKey = currentMemoryOwnerKey();
  if (!ownerKey) return;
  memorySelection = { ownerKey, server };
  removeLegacyServerSecrets();
  window.dispatchEvent(new Event(SERVER_SELECTION_EVENT));
}

export function loadAutomaticServerSelection(): boolean {
  try {
    const ownerKey = currentPreferenceOwnerKey();
    if (!ownerKey) return true;
    const raw = localStorage.getItem(AUTOMATIC_STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as Partial<StoredAutomaticSelection>;
    if (parsed.ownerKey !== ownerKey || typeof parsed.automatic !== "boolean") {
      localStorage.removeItem(AUTOMATIC_STORAGE_KEY);
      return true;
    }
    // A manual choice cannot survive a restart because its credential is not
    // persisted. Fall back to AUTO until the user selects a server again.
    return memorySelection?.ownerKey === ownerKey ? parsed.automatic : true;
  } catch {
    return true;
  }
}

export function saveAutomaticServerSelection(automatic: boolean): void {
  try {
    const ownerKey = currentPreferenceOwnerKey();
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
  memorySelection = null;
  removeLegacyServerSecrets();
  window.dispatchEvent(new Event(SERVER_SELECTION_EVENT));
}

export function clearLastServer(): void {
  memorySelection = null;
  removeLegacyServerSecrets();
  try {
    localStorage.removeItem(AUTOMATIC_STORAGE_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(SERVER_SELECTION_EVENT));
}
