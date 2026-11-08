import { useEffect, useState } from "react";
import {
  getCachedRouterTraffic,
  getRouterLink,
  refreshRouterTraffic,
  ROUTER_CHANGED_EVENT,
  ROUTER_SECTION_AVAILABLE,
  ROUTER_TRAFFIC_EVENT,
  type RouterTrafficHour,
} from "./router";

const REFRESH_MS = 5 * 60_000;

/**
 * Traffic of the home network through the linked router, read over SSH at
 * most every `maxAgeMs` while the screen is open. `linked` is false without
 * a router, and the screens then show nothing about it.
 */
export function useRouterTraffic(maxAgeMs = REFRESH_MS): { linked: boolean; hours: RouterTrafficHour[] } {
  const [linked, setLinked] = useState(() => ROUTER_SECTION_AVAILABLE && !!getRouterLink());
  const [hours, setHours] = useState<RouterTrafficHour[]>(getCachedRouterTraffic);

  useEffect(() => {
    if (!ROUTER_SECTION_AVAILABLE) return;
    const update = () => {
      setLinked(!!getRouterLink());
      setHours(getCachedRouterTraffic());
    };
    window.addEventListener(ROUTER_CHANGED_EVENT, update);
    window.addEventListener(ROUTER_TRAFFIC_EVENT, update);
    void refreshRouterTraffic(maxAgeMs);
    const timer = window.setInterval(() => void refreshRouterTraffic(maxAgeMs), REFRESH_MS);
    return () => {
      window.removeEventListener(ROUTER_CHANGED_EVENT, update);
      window.removeEventListener(ROUTER_TRAFFIC_EVENT, update);
      window.clearInterval(timer);
    };
  }, [maxAgeMs]);

  return { linked, hours };
}
