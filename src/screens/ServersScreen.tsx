import { useCallback, useEffect, useRef, useState } from "react";
import { t, type StringKey } from "../i18n";
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
  selectBestVpnServer,
  type MeasuredVpnServer,
} from "../session/serverQuality";
import Spinner from "../components/Spinner";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
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
  ) : null;

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
  selectedServer,
  automaticServerSelection,
  previewServers,
  forceShowEndpoint,
}: {
  onBack: () => void;
  onSelect: (server: ServerItem) => void;
  onSelectAutomatic: (server: ServerItem) => void;
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
  const loading = serverLoading || pingLoading;

  const updateListFades = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    setListTopFade(element.scrollTop > 1);
    setListBottomFade(element.scrollTop < element.scrollHeight - element.clientHeight - 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenRef.current += 1;
      pingGenRef.current += 1;
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

  const showServers = useCallback((vpnServers: VpnServer[], forcePing = false) => {
    if (!mountedRef.current) return;
    setError(null);
    const items: ServerItem[] = vpnServers.map((s) => ({
      ...s,
      ping: 0,
    }));
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

  const selectAutomatic = useCallback(() => {
    void selectBestVpnServer(servers).then((best) => {
      if (mountedRef.current && best) {
        onSelectAutomatic(best);
      }
    });
  }, [onSelectAutomatic, servers]);

  const automaticEnabled = servers.some(isAvailableVpnServer);

  const load = useCallback(async (opts: { force?: boolean } = {}) => {
    const generation = ++loadGenRef.current;
    const isCurrent = () => mountedRef.current && generation === loadGenRef.current;
    if (previewServers) {
      if (!isCurrent()) return;
      showServers(previewServers, opts.force === true);
      setServerLoading(false);
      setError(null);
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
      if (opts.force) {
        // Server availability is decided by the direct subscription response.
        // Keep plan metadata refreshing without putting the bot in front of
        // the user's server refresh.
        void syncSubscription({ force: true }).catch(() => {});
      }
      const vpnServers = await fetchVpnServers();
      if (!isCurrent()) return;
      showServers(vpnServers, opts.force === true);
    } catch (e) {
      if (isCurrent() && cachedServers.length === 0) {
        setError(loadErrorText(e));
        setServers([]);
      }
    } finally {
      if (isCurrent()) setServerLoading(false);
    }
  }, [previewServers, showServers]);

  useEffect(() => {
    load();
  }, [load]);

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
      <div className="servers-list-wrap">
        <div
          className={`servers-list ${loading && servers.length === 0 ? "spinner-center" : ""}`}
          ref={listRef}
          onScroll={updateListFades}
          style={{
            WebkitMaskImage: `linear-gradient(to bottom, ${listTopFade ? "transparent" : "#000"} 0, #000 38px, #000 calc(100% - 38px), ${listBottomFade ? "transparent" : "#000"} 100%)`,
            maskImage: `linear-gradient(to bottom, ${listTopFade ? "transparent" : "#000"} 0, #000 38px, #000 calc(100% - 38px), ${listBottomFade ? "transparent" : "#000"} 100%)`,
          }}
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
          {servers.map((server) => {
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
