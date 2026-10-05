import { useCallback, useEffect, useRef, useState } from "react";
import { t, tf, type StringKey } from "../i18n";
import {
  areCountryFlagsReady,
  countryFlagForUi,
  ensureCountryFlagsReady,
  serverCountryCodeForUi,
  serverDisplayName,
} from "../components/serverDisplay";
import {
  fetchVpnServers,
  getCachedVpnServers,
  isAvailableVpnServer,
  subscribeVpnServers,
  syncSubscription,
  type VpnServer,
} from "../session/auth";
import { isSameServerSelection } from "../session/serverSelection";
import {
  measureVpnServerPings,
  selectBestVerifiedVpnServer,
  type MeasuredVpnServer,
} from "../session/serverQuality";
import {
  cancelServerProbe,
  probeServerProfiles,
  serverProfileKey,
  type ServerProbeProgress,
} from "../session/serverProbe";
import Spinner from "../components/Spinner";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import { applyEdgeFade } from "../components/ScrollEdgeAffordance";
import type { SelectedServer } from "../App";
import { useSession } from "../session/store";
import "./ServersScreen.css";

type ServerItem = MeasuredVpnServer;

function countryName(code: string | null | undefined): string {
  if (!code) return "";
  const key = `country_${code.toUpperCase()}` as StringKey;
  try {
    return t(key);
  } catch {
    return code;
  }
}

function pingColor(ping: number): string {
  if (ping < 100) return "var(--success)";
  if (ping < 200) return "var(--warning)";
  return "var(--danger)";
}

function loadErrorText(error: unknown): string {
  console.warn("[servers] load failed", error);
  return t("servers_load_error_details");
}

/** How long the Refresh check waits for the bot's subscription sync. */
const SUBSCRIPTION_SYNC_WAIT_MS = 4000;

/**
 * After an explicit end-to-end check, confirmed servers come first by real
 * delay and the rest keep their panel order at the bottom (Android:
 * sortVerifiedServersForDisplay). Before the check the panel order stays.
 */
function sortVerifiedServersForDisplay(servers: ServerItem[], measured: boolean): ServerItem[] {
  if (!measured) return servers;
  return servers
    .map((server, index) => ({ server, index }))
    .sort((a, b) => {
      const aOk = a.server.ping > 0;
      const bOk = b.server.ping > 0;
      if (aOk !== bOk) return aOk ? -1 : 1;
      if (aOk && a.server.ping !== b.server.ping) return a.server.ping - b.server.ping;
      return a.index - b.index;
    })
    .map(({ server }) => server);
}

/** How long the finished progress card stays before it folds away. */
const PROBE_PROGRESS_COMPLETION_HOLD_MS = 800;

function serverListItemKey(server: VpnServer): string {
  return [
    server.id,
    server.name,
    server.country ?? "",
    `${server.address}:${server.port}`,
    server.uuid,
    server.sni,
    server.public_key,
    server.short_id,
  ].join("|");
}

export function ServerListRow({
  server,
  flagsReady,
  showEndpoint = false,
  selected = false,
  onSelect,
}: {
  server: ServerItem;
  flagsReady: boolean;
  showEndpoint?: boolean;
  selected?: boolean;
  onSelect?: (server: ServerItem) => void;
}) {
  const clickable = isAvailableVpnServer(server);
  const unavailablePlaceholder = !clickable;
  const showCountryLine = showEndpoint || unavailablePlaceholder;
  const className = [
    "server-item",
    "server-item--server",
    !showCountryLine && !showEndpoint ? "server-item--compact" : "",
    showEndpoint ? "server-item--with-endpoint" : "",
    selected && clickable ? "server-item--selected" : "",
    !clickable ? "server-item--offline" : "",
  ].filter(Boolean).join(" ");
  const statusNode = unavailablePlaceholder ? (
    <span className="server-item__offline-badge">{t("server_offline")}</span>
  ) : server.ping < 0 ? (
    <span className="server-item__ping-unavailable">{t("server_unavailable")}</span>
  ) : server.ping > 0 ? (
    <div className="server-item__ping">
      <span className="server-item__ping-value" style={{ color: pingColor(server.ping) }}>
        {server.ping}
      </span>
      <span className="server-item__ping-unit">ms</span>
    </div>
  ) : (
    // Not measured yet: the same chip with a spinner, as on the phone.
    <div className="server-item__ping server-item__ping--loading" aria-label={t("server_ping_checking")}>
      <span className="server-item__ping-spinner" aria-hidden="true" />
    </div>
  );

  return (
    <div
      className={className}
      aria-current={selected && clickable ? "true" : undefined}
      onClick={() => {
        if (clickable) onSelect?.(server);
      }}
    >
      <div className="server-item__main">
        <span className="server-item__flag">
          {flagsReady ? countryFlagForUi(server.country, server.name) : ""}
        </span>
        <div className="server-item__info">
          <div className="server-item__name">
            {serverDisplayName(server.name, server.country)}
          </div>
          {showCountryLine && (
            <div className={`server-item__country ${unavailablePlaceholder ? "server-item__country--red" : ""}`}>
              {unavailablePlaceholder
                ? t("server_unavailable")
                : countryName(serverCountryCodeForUi(server.country, server.name))}
            </div>
          )}
        </div>
        {statusNode}
      </div>
      {showEndpoint && (
        <>
          <div className="server-item__divider" aria-hidden="true" />
          <div className="server-item__endpoint-row" aria-label="Server endpoint">
            <span className="server-item__endpoint-marker" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="4" y="5" width="16" height="5" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
                <rect x="4" y="14" width="16" height="5" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8 7.5h.01M8 16.5h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </span>
            <span className="server-item__endpoint-domain">{server.address}</span>
            <span className="server-item__endpoint-port">{server.port}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function ServersScreen({
  onBack,
  onSelect,
  onSelectAutomatic,
  onAutomaticRefreshed,
  selectedServer,
  automaticServerSelection,
  previewServers,
  forceShowEndpoint,
}: {
  onBack: () => void;
  onSelect: (server: ServerItem) => void;
  onSelectAutomatic: (server: ServerItem) => void;
  /** After a full check with automatic selection on: keep the best server. */
  onAutomaticRefreshed?: (server: ServerItem) => void;
  selectedServer: SelectedServer | null;
  automaticServerSelection: boolean;
  previewServers?: VpnServer[];
  forceShowEndpoint?: boolean;
}) {
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [serverLoading, setServerLoading] = useState(true);
  const [pingLoading, setPingLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flagsReady, setFlagsReady] = useState(areCountryFlagsReady);
  const session = useSession();
  const showEndpoint = forceShowEndpoint ?? session.isAdminProfile;
  const pingGenRef = useRef(0);
  const loadGenRef = useRef(0);
  const mountedRef = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const [listTopFade, setListTopFade] = useState(false);
  const [listBottomFade, setListBottomFade] = useState(false);
  // End-to-end check state (Android: standardProfile* in ServerListViewModel).
  const [probeProgress, setProbeProgress] = useState<ServerProbeProgress | null>(null);
  const [lastProbeProgress, setLastProbeProgress] = useState<ServerProbeProgress | null>(null);
  const [profileMeasured, setProfileMeasured] = useState(false);
  const profileMeasuredRef = useRef(false);
  const profileDelaysRef = useRef(new Map<string, number>());
  const probeGenRef = useRef(0);
  const probingRef = useRef(false);
  const pendingServersRef = useRef<VpnServer[] | null>(null);
  // Checks the progress card belongs to (quiet follow-up checks excluded).
  const progressGenRef = useRef(0);
  const probing = probeProgress !== null && profileMeasured === false;
  const loading = serverLoading || pingLoading || probing;

  const updateListFades = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    setListTopFade(maxScroll > 1 && element.scrollTop > 1);
    setListBottomFade(maxScroll > 1 && element.scrollTop < maxScroll - 1);
    // Gradual edge fade, as in ScrollEdgeAffordance (no pop on first scroll).
    applyEdgeFade(element);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenRef.current += 1;
      pingGenRef.current += 1;
      if (probeGenRef.current > 0) cancelServerProbe();
      probeGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (flagsReady) return;
    let cancelled = false;
    ensureCountryFlagsReady().then(() => {
      if (!cancelled) setFlagsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [flagsReady]);

  // runProfileCheck is declared below; showServers reaches it through a ref.
  const runProfileCheckRef = useRef<
    (list: VpnServer[], opts?: { onlyMissing?: boolean }) => Promise<Map<string, number> | null>
  >(async () => null);

  const showServers = useCallback((vpnServers: VpnServer[], forcePing = false) => {
    if (!mountedRef.current) return;
    setError(null);
    // While the full check runs the screen keeps the list being checked: the
    // subscription can hand out other hosts for the same server on every
    // request, and swapping rows mid-check left them without a result. The
    // newest list is applied when the check ends.
    if (probingRef.current) {
      pendingServersRef.current = vpnServers;
      return;
    }
    const items: ServerItem[] = vpnServers.map((s) => ({
      ...s,
      ping: 0,
    }));
    // Once the full check has run, its results stand; the TCP-only ping
    // would overwrite their meaning (as on the phone). Profiles the check has
    // not seen yet (a refreshed subscription) are checked on their own.
    if (profileMeasuredRef.current) {
      const results = profileDelaysRef.current;
      const missing = items.some(
        (item) => isAvailableVpnServer(item) && !results.has(serverProfileKey(item)),
      );
      setServers(
        items.map((item) => ({
          ...item,
          ping: isAvailableVpnServer(item) ? results.get(serverProfileKey(item)) ?? 0 : -1,
        })),
      );
      if (missing) void runProfileCheckRef.current(vpnServers, { onlyMissing: true });
      return;
    }
    setServers((current) =>
      items.map((item) => ({
        ...item,
        ping: current.find((server) => server.id === item.id)?.ping ?? item.ping,
      })),
    );
    const gen = ++pingGenRef.current;
    if (items.length === 0) {
      setPingLoading(false);
      return;
    }
    setPingLoading(true);
    void measureVpnServerPings(items, { force: forcePing })
      .then((pings) => {
        if (!mountedRef.current || pingGenRef.current !== gen) return;
        setServers((current) =>
          current.map((server) => ({
            ...server,
            ping: pings.get(server.id) ?? -1,
          })),
        );
      })
      .catch(() => {
        if (!mountedRef.current || pingGenRef.current !== gen) return;
        setServers((current) =>
          current.map((server) => ({
            ...server,
            ping: -1,
          })),
        );
      })
      .finally(() => {
        if (mountedRef.current && pingGenRef.current === gen) {
          setPingLoading(false);
        }
      });
  }, []);

  /**
   * Full end-to-end check of the given servers; results arrive one by one.
   * With `onlyMissing` the results of the last check are kept and only
   * profiles without one are checked, quietly: the progress card keeps
   * describing the check the user started, the new rows show their loader.
   */
  const runProfileCheck = useCallback(async (
    list: VpnServer[],
    opts: { onlyMissing?: boolean } = {},
  ): Promise<Map<string, number> | null> => {
    const generation = ++probeGenRef.current;
    const isCurrent = () => mountedRef.current && generation === probeGenRef.current;
    pingGenRef.current += 1; // drop any TCP results still in flight
    setPingLoading(false);
    const profileDelays = opts.onlyMissing ? new Map(profileDelaysRef.current) : new Map<string, number>();
    // Results by server id for this list, for automatic selection.
    const delays = new Map<string, number>();
    for (const server of list) {
      const known = profileDelays.get(serverProfileKey(server));
      if (known !== undefined) delays.set(server.id, known);
    }
    const toCheck = list.filter(
      (server) => isAvailableVpnServer(server) && !profileDelays.has(serverProfileKey(server)),
    );
    // The rows always show exactly the list being checked.
    setServers(
      list.map((server) => ({
        ...server,
        ping: isAvailableVpnServer(server) ? profileDelays.get(serverProfileKey(server)) ?? 0 : -1,
      })),
    );
    if (toCheck.length === 0) {
      profileDelaysRef.current = profileDelays;
      return delays;
    }
    const quiet = opts.onlyMissing === true;
    probingRef.current = true;
    pendingServersRef.current = null;
    const progressGen = quiet ? progressGenRef.current : ++progressGenRef.current;
    if (!quiet) {
      profileMeasuredRef.current = false;
      setProfileMeasured(false);
      const startProgress = { completed: 0, total: toCheck.length };
      setProbeProgress(startProgress);
      setLastProbeProgress(startProgress);
    }
    try {
      await probeServerProfiles(toCheck, (checked, delayMs, progress) => {
        if (!isCurrent()) return;
        delays.set(checked.id, delayMs);
        const checkedKey = serverProfileKey(checked);
        profileDelays.set(checkedKey, delayMs);
        setServers((current) =>
          current.map((server) =>
            serverProfileKey(server) === checkedKey ? { ...server, ping: delayMs } : server,
          ),
        );
        if (quiet) return;
        setProbeProgress((current) => {
          const next = {
            completed: Math.max(current?.completed ?? 0, progress.completed),
            total: progress.total,
          };
          setLastProbeProgress(next);
          return next;
        });
      });
    } catch (e) {
      console.warn("[servers] profile check failed", e);
    }
    if (generation === probeGenRef.current) probingRef.current = false;
    if (!isCurrent()) return null;
    // Anything that did not report is unconfirmed.
    for (const server of toCheck) {
      const key = serverProfileKey(server);
      if (!profileDelays.has(key)) profileDelays.set(key, -1);
    }
    setServers((current) =>
      current.map((server) => (server.ping === 0 ? { ...server, ping: -1 } : server)),
    );
    profileDelaysRef.current = profileDelays;
    profileMeasuredRef.current = true;
    setProfileMeasured(true);
    if (!quiet) {
      window.setTimeout(() => {
        if (mountedRef.current && progressGen === progressGenRef.current) setProbeProgress(null);
      }, PROBE_PROGRESS_COMPLETION_HOLD_MS);
    }
    // A list that arrived during the check replaces the rows now; new
    // profiles in it get their own check.
    const pending = pendingServersRef.current;
    pendingServersRef.current = null;
    if (pending) showServers(pending);
    return delays;
  }, [showServers]);
  runProfileCheckRef.current = runProfileCheck;

  const selectAutomatic = useCallback(() => {
    void (async () => {
      let delays: Map<string, number> | null;
      if (profileMeasuredRef.current || probeProgress !== null) {
        // A running check reports progressively: an already confirmed server
        // may be chosen without waiting for every failed timeout.
        delays = new Map(servers.map((server) => [server.id, server.ping]));
      } else {
        delays = await runProfileCheck(servers);
      }
      if (!delays || !mountedRef.current) return;
      const best = selectBestVerifiedVpnServer(servers, delays);
      if (best) onSelectAutomatic(best);
    })();
  }, [onSelectAutomatic, probeProgress, runProfileCheck, servers]);

  // With a check running or done, AUTO must never pick a server that only
  // exposed an open TCP port.
  const automaticEnabled = profileMeasured || probeProgress !== null
    ? servers.some((server) => server.ping > 0)
    : servers.some(isAvailableVpnServer);
  const displayedServers = sortVerifiedServersForDisplay(servers, profileMeasured);

  const load = useCallback(async (opts: { force?: boolean } = {}) => {
    const generation = ++loadGenRef.current;
    const isCurrent = () => mountedRef.current && generation === loadGenRef.current;
    if (previewServers) {
      if (!isCurrent()) return;
      showServers(previewServers);
      setServerLoading(false);
      setError(null);
      if (opts.force) void runProfileCheck(previewServers);
      return;
    }

    const cachedServers = getCachedVpnServers();
    if (cachedServers.length > 0) {
      showServers(cachedServers);
    }
    if (!isCurrent()) return;
    setServerLoading(true);
    setError(null);
    try {
      // Force the subscription sync only when the user explicitly hit the
      // Refresh button — opening the screen normally rides the throttle
      // window so re-entering doesn't hammer the panel.
      // The bot's sync also rewrites the server list, often with other hosts
      // for the same servers; the check waits for it (at most a few seconds)
      // so it covers the list the screen ends up with.
      const subscriptionSynced = opts.force
        ? syncSubscription({ force: true }).catch(() => {})
        : null;
      const fetchedServers = await fetchVpnServers();
      if (!isCurrent()) return;
      if (opts.force) {
        await Promise.race([
          subscriptionSynced,
          new Promise((resolve) => window.setTimeout(resolve, SUBSCRIPTION_SYNC_WAIT_MS)),
        ]);
        if (!isCurrent()) return;
        const latest = getCachedVpnServers();
        const vpnServers = latest.length > 0 ? latest : fetchedServers;
        // The refresh button runs the full end-to-end check (Android); it
        // shows the rows itself.
        setServerLoading(false);
        const delays = await runProfileCheck(vpnServers);
        if (delays && automaticServerSelection && onAutomaticRefreshed) {
          const best = selectBestVerifiedVpnServer(vpnServers, delays);
          if (best) onAutomaticRefreshed(best);
        }
      } else {
        showServers(fetchedServers);
      }
    } catch (e) {
      if (isCurrent() && cachedServers.length === 0) {
        setError(loadErrorText(e));
        setServers([]);
      }
    } finally {
      if (isCurrent()) setServerLoading(false);
    }
  }, [automaticServerSelection, onAutomaticRefreshed, previewServers, runProfileCheck, showServers]);

  useEffect(() => {
    load();
    // Only on open: later prop changes must not start another check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (previewServers) return;
    return subscribeVpnServers(() => {
      const cachedServers = getCachedVpnServers();
      // An empty list is authoritative too (revocation or plan change).
      showServers(cachedServers);
    });
  }, [previewServers, showServers]);

  useEffect(() => {
    const frame = requestAnimationFrame(updateListFades);
    return () => cancelAnimationFrame(frame);
  }, [servers.length, error, serverLoading, updateListFades]);

  return (
    <div className="servers-root">
      {/* Top bar */}
      <div className="servers-topbar">
        <button className="servers-topbar__back" onClick={onBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="servers-topbar__title">{t("server_select")}</span>
        <TopbarRefreshButton
          label={t("refresh")}
          loading={loading}
          onClick={() => load({ force: true })}
          disabled={loading}
        />
      </div>

      {/* Server list / states. Only this middle section scrolls; the top bar
          remains visible and the edge cues make additional rows discoverable. */}
      {/* "Checked N of M" while the full check runs (Android:
          ServerProbeProgressBar); folds away shortly after it finishes. */}
      <div className={`servers-probe ${probeProgress ? "servers-probe--open" : ""}`} aria-live="polite">
        <div className="servers-probe__inner">
          {lastProbeProgress && (
            <div className="servers-probe__card">
              <div className="servers-probe__text">
                {tf("servers_probe_progress", lastProbeProgress.completed, lastProbeProgress.total)}
              </div>
              <div className="servers-probe__track">
                <div
                  className="servers-probe__fill"
                  style={{
                    width: `${lastProbeProgress.total > 0
                      ? Math.min(100, (lastProbeProgress.completed / lastProbeProgress.total) * 100)
                      : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="servers-list-wrap">
        <div
          className={`servers-list ${loading && servers.length === 0 ? "spinner-center" : ""}`}
          ref={listRef}
          onScroll={updateListFades}
        >
        {loading && servers.length === 0 ? (
          <Spinner size={36} />
        ) : error ? (
          <div className="server-item" style={{ justifyContent: "center" }}>
            <div className="server-item__info">
              <div className="server-item__name">{t("servers_load_error")}</div>
              <div className="server-item__country">{error}</div>
            </div>
          </div>
        ) : servers.length === 0 ? (
          <div className="server-item" style={{ justifyContent: "center" }}>
            <div className="server-item__info">
              <div className="server-item__name">{t("servers_empty")}</div>
            </div>
          </div>
        ) : (
          <>
          <div
            className={[
              "server-item",
              "server-item--automatic",
              automaticServerSelection ? "server-item--selected" : "",
              !automaticEnabled ? "server-item--offline" : "",
            ].filter(Boolean).join(" ")}
            aria-current={automaticServerSelection ? "true" : undefined}
            onClick={automaticEnabled ? selectAutomatic : undefined}
          >
            <span className="server-item__auto-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M13 2 4.5 13.2h6.1L10.9 22 19.5 10.8h-6.1L13 2Z" />
              </svg>
            </span>
            <div className="server-item__info">
              <div className="server-item__name">{t("server_auto")}</div>
              <div className="server-item__country">{t("server_auto_description")}</div>
            </div>
          </div>
          {displayedServers.map((server) => {
            const selected =
              !automaticServerSelection &&
              isAvailableVpnServer(server) &&
              isSameServerSelection(selectedServer, server);
            return (
              <ServerListRow
                key={serverListItemKey(server)}
                server={server}
                flagsReady={flagsReady}
                showEndpoint={showEndpoint}
                selected={selected}
                onSelect={onSelect}
              />
            );
          })}
          </>
        )}
        </div>
        <div className={`servers-scroll-arrow servers-scroll-arrow--top ${listTopFade ? "is-visible" : ""}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15" /></svg>
        </div>
        <div className={`servers-scroll-arrow servers-scroll-arrow--bottom ${listBottomFade ? "is-visible" : ""}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      </div>
    </div>
  );
}
