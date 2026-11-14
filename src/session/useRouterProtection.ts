import { useEffect, useState } from "react";
import { serverDisplayName } from "../components/serverDisplay";
import { isBrowserPreviewRuntime } from "./browserPreview";
import {
  detectRouter,
  getRouterLink,
  isLinkedRouterHere,
  ROUTER_CHANGED_EVENT,
  ROUTER_SECTION_AVAILABLE,
  routerSnapshot,
} from "./router";

/** Whether the home router already sends this computer through the VPN. */
export interface RouterProtection {
  active: boolean;
  /** Server the router uses for this computer, for display. */
  serverName: string | null;
}

const NONE: RouterProtection = { active: false, serverName: null };
const CHECK_EVERY_MS = 3 * 60_000;

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
    const link = getRouterLink();
    if (!link || !(await isLinkedRouterHere(link, info))) return NONE;
    // Status and devices in one login.
    const { status, network } = await routerSnapshot(link);
    if (!status.installed || !status.running || !status.clientIp || !network) return NONE;
    const me = network.devices.find((device) => device.ip === status.clientIp);
    if (!me) return NONE;
    const mode = me.mode === "default" ? status.defaultMode : me.mode;
    if (mode !== "vpn") return NONE;
    const slot = me.mode === "vpn" ? me.slot : 0;
    if (status.downSlots.includes(slot)) return NONE;
    const server =
      network.slots.find((item) => item.slot === slot) ?? network.slots.find((item) => item.slot === 0);
    return { active: true, serverName: server ? serverDisplayName(server.serverName, null) : null };
  } catch {
    return NONE;
  }
}

export function useRouterProtection(): RouterProtection {
  const [protection, setProtection] = useState<RouterProtection>(NONE);

  useEffect(() => {
    if (!ROUTER_SECTION_AVAILABLE) return;
    let alive = true;
    let running = false;
    const check = () => {
      if (running) return;
      running = true;
      void checkRouterProtection()
        .then((next) => {
          if (alive) setProtection(next);
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
