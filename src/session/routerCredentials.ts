import { fetchSubscriptionProfile } from "./subscriptionPinger";
import { fetchVpnServers, getCachedVpnServers, isAvailableVpnServer } from "./auth";
import { getSession } from "./store";
import { serverProfileConfig } from "./vpn";
import {
  accountRouters,
  accountSubscriptionUrl,
  rewriteRouterServers,
  routerSubscriptionLink,
  type RouterLink,
  type RouterStatus,
} from "./router";

/**
 * Brings the router onto the account's current credentials after its link
 * was reset elsewhere (another device unlinked with a reset, the bot): the
 * router would otherwise keep logging in with the revoked ones and quietly
 * send the home direct. As on the phone.
 *
 * It writes only on proof, never on a guess: the router's link and this
 * app's link differ, the router is this account's, and, asked one right
 * after the other in the same way, this app's link answers with servers while
 * the router's is refused. A timeout or network error is "not known" and
 * writes nothing; a router link that still answers is never touched (so
 * revoked credentials can never replace live ones).
 */
export type RepairResult = { kind: "updated"; status: RouterStatus } | { kind: "current" } | { kind: "unknown" };

type LinkState = "live" | "dead" | "unknown";

async function linkState(url: string, key: string): Promise<LinkState> {
  const profile = await fetchSubscriptionProfile(url, key).catch(() => null);
  if (!profile) return "unknown";
  if (profile.isSuccessful && profile.links.length > 0) return "live";
  // A blocked (expired) subscription still exists: not a revoked link.
  if (profile.isUsageBlocked) return "live";
  if (!profile.isSuccessful && profile.links.length === 0) return "dead";
  return "unknown";
}

let running: Promise<RepairResult> | null = null;
let lastBackgroundAt = 0;
const BACKGROUND_EVERY_MS = 6 * 60 * 60 * 1000;

/** The background check (Home), at most every few hours. */
export async function repairRouterCredentialsInBackground(link: RouterLink): Promise<RepairResult> {
  const now = Date.now();
  if (lastBackgroundAt && now - lastBackgroundAt < BACKGROUND_EVERY_MS) return { kind: "unknown" };
  const result = await repairRouterCredentials(link);
  if (result.kind !== "unknown") lastBackgroundAt = now;
  return result;
}

/** One check at a time; `beforeWrite` may refuse the write (the screen is busy). */
export function repairRouterCredentials(
  link: RouterLink,
  beforeWrite: () => boolean = () => true,
): Promise<RepairResult> {
  if (running) return running;
  running = repairNow(link, beforeWrite)
    .catch((): RepairResult => ({ kind: "unknown" }))
    .finally(() => {
      running = null;
    });
  return running;
}

async function repairNow(link: RouterLink, beforeWrite: () => boolean): Promise<RepairResult> {
  const key = getSession().shortUuid;
  if (!key) return { kind: "unknown" };
  const router = await routerSubscriptionLink(link);
  if (!router) return { kind: "unknown" };
  if (router.url.includes(key)) return { kind: "current" };
  // Only this account's router gets this account's credentials.
  if (!router.hwid) return { kind: "unknown" };
  const routers = await accountRouters();
  if (routers.length === 0) return { kind: "unknown" };
  if (!routers.some((item) => item.id.toLowerCase() === router.hwid!.toLowerCase())) return { kind: "current" };
  const ownUrl = accountSubscriptionUrl();
  if (!ownUrl || (await linkState(ownUrl, key)) !== "live") return { kind: "unknown" };
  const routerKey = router.url.split("?")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  const state = await linkState(router.url, routerKey);
  if (state === "live") return { kind: "current" };
  if (state === "unknown") return { kind: "unknown" };
  await fetchVpnServers().catch(() => []);
  const servers = getCachedVpnServers().filter(isAvailableVpnServer);
  if (servers.length === 0 || !beforeWrite()) return { kind: "unknown" };
  const status = await rewriteRouterServers(
    link,
    servers.map((server) => ({ slot: 0, id: server.id, name: server.name, server: serverProfileConfig(server) })),
    ownUrl,
  );
  return status ? { kind: "updated", status } : { kind: "unknown" };
}
