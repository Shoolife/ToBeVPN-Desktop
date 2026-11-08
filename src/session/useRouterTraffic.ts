import { useEffect, useState } from "react";
import {
  getCachedRouterTraffic,
  getRouterLink,
  isRouterTrafficLoading,
  refreshRouterTraffic,
  ROUTER_CHANGED_EVENT,
  ROUTER_SECTION_AVAILABLE,
  ROUTER_TRAFFIC_EVENT,
  ROUTER_TRAFFIC_LOADING_EVENT,
  type RouterTrafficHour,
} from "./router";

const REFRESH_MS = 5 * 60_000;
/** A read shorter than this still shows its spinner this long, not as a flash. */
const MIN_LOADING_MS = 600;

/**
 * Traffic of the home network through the linked router, read over SSH at
 * most every `maxAgeMs` while the screen is open. `linked` is false without
 * a router, and the screens then show nothing about it.
 */
export function useRouterTraffic(maxAgeMs = REFRESH_MS): {
  linked: boolean;
  hours: RouterTrafficHour[];
  /** A read from the router is running. */
  loading: boolean;
} {
  const [linked, setLinked] = useState(() => ROUTER_SECTION_AVAILABLE && !!getRouterLink());
  const [hours, setHours] = useState<RouterTrafficHour[]>(getCachedRouterTraffic);
  const [loading, setLoading] = useState(isRouterTrafficLoading);

  useEffect(() => {
    let startedAt = 0;
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      if (isRouterTrafficLoading()) {
        startedAt = performance.now();
        setLoading(true);
      } else {
        const left = MIN_LOADING_MS - (performance.now() - startedAt);
        timer = window.setTimeout(() => setLoading(false), Math.max(0, left));
      }
    };
    window.addEventListener(ROUTER_TRAFFIC_LOADING_EVENT, update);
    return () => {
      window.removeEventListener(ROUTER_TRAFFIC_LOADING_EVENT, update);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!ROUTER_SECTION_AVAILABLE) return;
    const update = () => {
      setLinked(!!getRouterLink());
      setHours(getCachedRouterTraffic());
    };
    window.addEventListener(ROUTER_CHANGED_EVENT, update);
    window.addEventListener(ROUTER_TRAFFIC_EVENT, update);
    void refreshRouterTraffic(maxAgeMs);
    // Read again as often as the screen wants it fresh (the router counts
    // every minute, so never more often than that).
    const every = Math.max(60_000, maxAgeMs);
    const timer = window.setInterval(() => void refreshRouterTraffic(every - 5_000), every);
    return () => {
      window.removeEventListener(ROUTER_CHANGED_EVENT, update);
      window.removeEventListener(ROUTER_TRAFFIC_EVENT, update);
      window.clearInterval(timer);
    };
  }, [maxAgeMs]);

  return { linked, hours, loading };
}
