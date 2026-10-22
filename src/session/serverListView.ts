import { useEffect, useState } from "react";

// How server rows are drawn. Admins pick it in Personalization -> Server list;
// everyone else always gets USER_SERVER_LIST_VIEW (the protocol name under
// the server name, as on Android).

/** "protocolFull" is the protocol with its build: "VLESS · REALITY · XHTTP". */
export type ServerSubtitle = "country" | "protocol" | "protocolFull" | "none";

export interface ServerListView {
  /** Line under the server name. */
  subtitle: ServerSubtitle;
  /** Row with the server's address and port. */
  endpoint: boolean;
  /** Row with the protocol, its build ("REALITY · XHTTP") and TCP/UDP. */
  protocol: boolean;
}

export type ServerListPreset =
  | "detailed"
  | "condensed"
  | "technical"
  | "address"
  | "user"
  | "compact";

export const SERVER_LIST_PRESETS: Record<ServerListPreset, ServerListView> = {
  // Everything an admin may need to tell servers apart (the default).
  detailed: { subtitle: "country", endpoint: true, protocol: true },
  // Country and how the profile is built, without the address.
  condensed: { subtitle: "country", endpoint: false, protocol: true },
  // The full protocol in the country's place, and the address.
  technical: { subtitle: "protocolFull", endpoint: true, protocol: false },
  // Country and address, without the protocol.
  address: { subtitle: "country", endpoint: true, protocol: false },
  // Exactly what users see.
  user: { subtitle: "protocol", endpoint: false, protocol: false },
  // One line per server: the longest lists fit on screen.
  compact: { subtitle: "none", endpoint: false, protocol: false },
};

export const SERVER_LIST_PRESET_ORDER: readonly ServerListPreset[] = [
  "detailed",
  "condensed",
  "technical",
  "address",
  "user",
  "compact",
];

export const ADMIN_DEFAULT_SERVER_LIST_VIEW = SERVER_LIST_PRESETS.detailed;
export const USER_SERVER_LIST_VIEW = SERVER_LIST_PRESETS.user;

const STORAGE_KEY = "tobevpn:server-list-view:v1";
const CHANGE_EVENT = "tobevpn:server-list-view-changed";

function isSubtitle(value: unknown): value is ServerSubtitle {
  return value === "country" || value === "protocol" || value === "protocolFull" || value === "none";
}

export function loadServerListView(): ServerListView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return ADMIN_DEFAULT_SERVER_LIST_VIEW;
    const parsed = JSON.parse(raw) as Partial<ServerListView>;
    return {
      subtitle: isSubtitle(parsed.subtitle)
        ? parsed.subtitle
        : ADMIN_DEFAULT_SERVER_LIST_VIEW.subtitle,
      endpoint: typeof parsed.endpoint === "boolean"
        ? parsed.endpoint
        : ADMIN_DEFAULT_SERVER_LIST_VIEW.endpoint,
      protocol: typeof parsed.protocol === "boolean"
        ? parsed.protocol
        : ADMIN_DEFAULT_SERVER_LIST_VIEW.protocol,
    };
  } catch {
    return ADMIN_DEFAULT_SERVER_LIST_VIEW;
  }
}

export function saveServerListView(view: ServerListView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage unavailable: the choice lasts until the window reloads.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function matchingServerListPreset(view: ServerListView): ServerListPreset | null {
  return SERVER_LIST_PRESET_ORDER.find((preset) => {
    const candidate = SERVER_LIST_PRESETS[preset];
    return (
      candidate.subtitle === view.subtitle &&
      candidate.endpoint === view.endpoint &&
      candidate.protocol === view.protocol
    );
  }) ?? null;
}

/** The admin's saved view, kept current across screens. */
export function useServerListView(): ServerListView {
  const [view, setView] = useState(loadServerListView);
  useEffect(() => {
    const update = () => setView(loadServerListView());
    window.addEventListener(CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CHANGE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return view;
}
