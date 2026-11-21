import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { isBrowserPreviewRuntime } from "./browserPreview";
import { recordDiagnosticEvent } from "./diagnostics";
import { detectRouter, ROUTER_SECTION_AVAILABLE } from "./router";
import { checkRouterProtection } from "./useRouterProtection";
import {
  connectVpn,
  disconnectVpn,
  getActiveVpnReconnectServer,
  getVpnRuntime,
  subscribeVpnRuntime,
} from "./vpnState";
import type { ServerVpnConfig } from "./vpn";

// "Pause VPN at home", as on the phone: behind the linked router that already
// sends this computer through its VPN, the computer's own VPN is turned off,
// and on again (the same server) when it leaves that network or the router's
// VPN stops. A computer may start the VPN at any time, so a pause is simply a
// disconnect that remembers its server.

const SETTING_KEY = "tobevpn_pause_at_home";
const CHECK_EVERY_MS = 60_000;
const RECHECK_MS = 20_000;
const SETTLE_MS = 3_000;

export function isPauseAtHomeEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPauseAtHomeEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(SETTING_KEY, "1");
    else localStorage.removeItem(SETTING_KEY);
  } catch {
    // Not remembered; the watch reads it again at its next check.
  }
  nudge();
}

/** The VPN paused here, and the network (gateway) it was paused on. */
let paused: { server: ServerVpnConfig; gateway: string | null } | null = null;
/** A connect by hand while paused: no pause on this network until it changes. */
let declinedGateway: string | null = null;
let missedChecks = 0;
/** A connect by hand is being looked at: no pause meanwhile. */
let holdUntil = 0;
const noticeListeners = new Set<() => void>();

/**
 * A connect by hand at home that the pause leaves alone (Home tells so at the
 * bottom, as on the phone).
 */
export function onHomeConnectNotice(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
}

function announceStayingOn() {
  noticeListeners.forEach((listener) => listener());
}
let ourConnect = false;
let running = false;
let nudgeTimer: number | null = null;

function notify(title: string, body: string) {
  if (isBrowserPreviewRuntime()) return;
  void invoke("show_system_notification", { kind: "home_pause", title, body }).catch(() => {});
}

function nudge(delayMs = SETTLE_MS) {
  if (nudgeTimer !== null) window.clearTimeout(nudgeTimer);
  nudgeTimer = window.setTimeout(() => {
    nudgeTimer = null;
    void check();
  }, delayMs);
}

async function currentGateway(): Promise<string | null> {
  try {
    return (await detectRouter(true)).gateway;
  } catch {
    return null;
  }
}

async function check(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const enabled = isPauseAtHomeEnabled();
    if (paused) {
      const gateway = await currentGateway();
      const sameNetwork = gateway !== null && gateway === paused.gateway;
      const protection = enabled && sameNetwork ? await checkRouterProtection() : null;
      if (protection?.active) {
        missedChecks = 0;
        return;
      }
      missedChecks += 1;
      // Another network or the setting off: at once. A missed answer at
      // home (the router busy a moment) only on the second in a row.
      if (enabled && sameNetwork && missedChecks < 2) {
        nudge(RECHECK_MS);
        return;
      }
      const server = paused.server;
      paused = null;
      recordDiagnosticEvent("HomePause", `Leaving home: the VPN resumes (same_network=${sameNetwork})`);
      notify(t("home_pause_notice_resumed_title"), t("home_pause_notice_resumed_text"));
      ourConnect = true;
      try {
        await connectVpn(server);
      } catch {
        // The VPN screen shows the error, as for any connect.
      } finally {
        ourConnect = false;
      }
      return;
    }
    const runtime = getVpnRuntime();
    if (!enabled || !runtime.connected || Date.now() < holdUntil) return;
    const gateway = await currentGateway();
    // Without a known network leaving it could not be told: no pause.
    if (gateway === null || gateway === declinedGateway) return;
    const protection = await checkRouterProtection();
    if (!protection.active || !getVpnRuntime().connected) return;
    const server = getActiveVpnReconnectServer();
    if (!server) return;
    paused = { server, gateway };
    missedChecks = 0;
    recordDiagnosticEvent("HomePause", "VPN paused at home behind the router's VPN");
    await disconnectVpn();
    notify(t("home_pause_notice_paused_title"), t("home_pause_notice_paused_text"));
  } finally {
    running = false;
  }
}

let started = false;

/** Starts the watch once per run (main.tsx). */
export function startHomePauseWatch(): void {
  if (started || !ROUTER_SECTION_AVAILABLE || isBrowserPreviewRuntime()) return;
  started = true;
  window.setInterval(() => void check(), CHECK_EVERY_MS);
  // Another network: asked a moment after it settles.
  window.addEventListener("online", () => nudge());
  window.addEventListener("offline", () => nudge());
  let wasConnected = getVpnRuntime().connected;
  subscribeVpnRuntime(() => {
    const connected = getVpnRuntime().connected;
    if (connected && !wasConnected && !ourConnect) {
      if (paused) {
        // Connected by hand while paused: wanted here after all.
        declinedGateway = paused.gateway;
        paused = null;
        announceStayingOn();
      } else if (isPauseAtHomeEnabled()) {
        // Connected by hand at home behind the router's VPN: stays on until
        // the network changes, and Home says so. Elsewhere nothing changes.
        holdUntil = Date.now() + 30_000;
        void (async () => {
          try {
            const protection = await checkRouterProtection();
            if (!protection.active) return;
            const gateway = await currentGateway();
            if (gateway === null) return;
            declinedGateway = gateway;
            announceStayingOn();
          } finally {
            holdUntil = 0;
          }
        })();
      }
    }
    wasConnected = connected;
  });
  // A new network clears a declined pause.
  window.setInterval(() => {
    if (declinedGateway === null) return;
    void currentGateway().then((gateway) => {
      if (gateway !== declinedGateway) declinedGateway = null;
    });
  }, CHECK_EVERY_MS);
  nudge();
}
