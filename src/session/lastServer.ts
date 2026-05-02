// Persists the last server the user picked so it's pre-selected on next launch.
// VPN is not auto-started — only the selection is restored.
import type { SelectedServer } from "../App";

const STORAGE_KEY = "tobevpn_last_server_v1";

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

export function loadLastServer(): SelectedServer | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (isSelectedServer(parsed)) return parsed;
    localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

export function saveLastServer(server: SelectedServer) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(server));
  } catch {
    // ignore
  }
}
