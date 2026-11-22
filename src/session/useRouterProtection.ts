import { useEffect, useState } from "react";
import { serverDisplayName } from "../components/serverDisplay";
import { isBrowserPreviewRuntime } from "./browserPreview";
import { repairRouterCredentialsInBackground } from "./routerCredentials";
import {
  detectRouter,
  getRouterLink,
  identifyRouterHere,
  isLinkedRouterHere,
  ROUTER_CHANGED_EVENT,
  ROUTER_SECTION_AVAILABLE,
  routerSnapshot,
  routerDeviceSlot,
  syncRouterServerHosts,
} from "./router";
import { recordDiagnosticEvent } from "./diagnostics";

/** Whether the home router already sends this computer through the VPN. */
export interface RouterProtection {
  active: boolean;
  /** Server the router uses for this computer, for display. */
  serverName: string | null;
}

const NONE: RouterProtection = { active: false, serverName: null };
const CHECK_EVERY_MS = 3 * 60_000;

/**
 * The last answer in this run of the app: a screen opened later shows it at
 * once (Home has usually just asked) instead of first claiming a direct
 * line, and asks again in the background.
 */
let lastKnown: RouterProtection | null = null;

/**
 * At home behind a router with ToBeVPN, and the router sends this computer
 * through a server that answers. Anything else (another network, the VPN
 * on the router stopped, this computer set to "No VPN", its server down)
 * is "not protected", so the app never claims a VPN that is not there.
 */
export async function checkRouterProtection(): Promise<RouterProtection> {
  if (!ROUTER_SECTION_AVAILABLE || isBrowserPreviewRuntime()) return NONE;
  try {
    // This network's router first: of several connected routers, the link
    // is the one of the network the computer is on now.
    const info = await detectRouter(true);
    await identifyRouterHere(info);
    const link = getRouterLink();
    if (!link || !(await isLinkedRouterHere(link, info))) return NONE;
    // Status and devices in one login.
    let { status, network } = await routerSnapshot(link);
    // After a link reset elsewhere the router gets the new credentials
    // without anyone opening its screen (at most every few hours; it writes
    // only on proof). Also when its VPN looks off: that is one reason for it.
    if (status.installed) {
      const repaired = await repairRouterCredentialsInBackground(link);
      if (repaired.kind === "updated") ({ status, network } = await routerSnapshot(link));
      // The subscription's servers the router does not send direct yet are
      // added (at most every half hour), so this computer's own VPN reaches
      // a server added after the router's setup.
      void syncRouterServerHosts(link).catch((error) =>
        recordDiagnosticEvent("Router", `Router server list sync failed: ${String(error)}`, "W"),
      );
    }
    if (!status.installed || !status.running || !status.clientIp || !network) return NONE;
    const me = network.devices.find((device) => device.ip === status.clientIp);
    if (!me) return NONE;
    const mode = me.mode === "default" ? status.defaultMode : me.mode;
    if (mode !== "vpn") return NONE;
    // A "default" device rides the slot its entry names, like a chosen one
    // (slot 0 when that slot has no server on the router, as the agent reads it).
    const slot = routerDeviceSlot(me, network);
    if (status.downSlots.includes(slot)) return NONE;
    const server =
      network.slots.find((item) => item.slot === slot) ?? network.slots.find((item) => item.slot === 0);
    return { active: true, serverName: server ? serverDisplayName(server.serverName, null) : null };
  } catch {
    return NONE;
  }
}

/** The hook's answer; `known` is false until the first check this run. */
export type RouterProtectionState = RouterProtection & { known: boolean };

export function useRouterProtection(): RouterProtectionState {
  const [protection, setProtection] = useState<RouterProtectionState>(() =>
    !ROUTER_SECTION_AVAILABLE
      ? { ...NONE, known: true }
      : lastKnown
        ? { ...lastKnown, known: true }
        : { ...NONE, known: false },
  );

  useEffect(() => {
    if (!ROUTER_SECTION_AVAILABLE) return;
    let alive = true;
    let running = false;
    const check = () => {
      if (running) return;
      running = true;
      void checkRouterProtection()
        .then((next) => {
          lastKnown = next;
          if (alive) setProtection({ ...next, known: true });
        })
        .finally(() => {
          running = false;
        });
    };
    check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    // Another network, or the router's settings changed in the app.
    window.addEventListener("online", check);
    window.addEventListener(ROUTER_CHANGED_EVENT, check);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("online", check);
      window.removeEventListener(ROUTER_CHANGED_EVENT, check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return protection;
}
