import { useCallback, useEffect, useRef, useState } from "react";
import { t, type StringKey } from "../i18n";
import {
  countryFlagForUi,
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
import type { SelectedServer } from "../App";
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
  if (ping < 100) return "#4CAF50";
  if (ping < 200) return "#FF9800";
  return "#F44336";
}

export default function ServersScreen({
  onBack,
  onSelect,
  onSelectAutomatic,
  selectedServer,
  automaticServerSelection,
}: {
  onBack: () => void;
  onSelect: (server: ServerItem) => void;
  onSelectAutomatic: (server: ServerItem) => void;
  selectedServer: SelectedServer | null;
  automaticServerSelection: boolean;
}) {
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flagsReady, setFlagsReady] = useState(false);
  const pingGenRef = useRef(0);

  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) {
      setFlagsReady(true);
      return;
    }
    document.fonts
      .load('16px "Twemoji Country Flags"')
      .then(() => setFlagsReady(true))
      .catch(() => setFlagsReady(true));
  }, []);

  const showServers = useCallback((vpnServers: VpnServer[]) => {
    const items: ServerItem[] = vpnServers.map((s) => ({
      ...s,
      ping: 0,
    }));
    setServers(items);
    const gen = ++pingGenRef.current;
    void measureVpnServerPings(items, { force: true }).then((pings) => {
      if (pingGenRef.current !== gen) return;
      setServers((current) =>
        current.map((server) => ({
          ...server,
          ping: pings.get(server.id) ?? -1,
        })),
      );
    });
  }, []);

  const selectAutomatic = useCallback(() => {
    void selectBestVpnServer(servers).then((best) => {
      if (best) {
        onSelectAutomatic(best);
      }
    });
  }, [onSelectAutomatic, servers]);

  const automaticEnabled = servers.some(
    (server) => isAvailableVpnServer(server) && server.ping > 0,
  );

  const load = useCallback(async (opts: { force?: boolean } = {}) => {
    const cachedServers = getCachedVpnServers();
    if (cachedServers.length > 0) {
      showServers(cachedServers);
    }
    setLoading(true);
    setError(null);
    try {
      // Force the subscription sync only when the user explicitly hit the
      // Refresh button — opening the screen normally rides the throttle
      // window so re-entering doesn't hammer the panel.
      if (opts.force) {
        await syncSubscription({ force: true }).catch(() => {});
      }
      const vpnServers = await fetchVpnServers();
      showServers(vpnServers);
    } catch (e) {
      if (cachedServers.length === 0) {
        setError(e instanceof Error ? e.message : String(e));
        setServers([]);
      }
    } finally {
      setLoading(false);
    }
  }, [showServers]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return subscribeVpnServers(() => {
      const cachedServers = getCachedVpnServers();
      if (cachedServers.length > 0) {
        showServers(cachedServers);
      }
    });
  }, [showServers]);

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
        <button
          className="servers-topbar__refresh"
          title={t("refresh")}
          onClick={() => load({ force: true })}
          disabled={loading}
        >
          <svg
            className={loading ? "servers-topbar__refresh-icon servers-topbar__refresh-icon--spinning" : "servers-topbar__refresh-icon"}
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Server list / states */}
      {loading && servers.length === 0 ? (
        <div className="servers-list spinner-center">
          <Spinner size={36} />
        </div>
      ) : error ? (
        <div className="servers-list">
          <div className="server-item" style={{ justifyContent: "center" }}>
            <div className="server-item__info">
              <div className="server-item__name">{t("servers_load_error")}</div>
              <div className="server-item__country">{error}</div>
            </div>
          </div>
        </div>
      ) : servers.length === 0 ? (
        <div className="servers-list">
          <div className="server-item" style={{ justifyContent: "center" }}>
            <div className="server-item__info">
              <div className="server-item__name">{t("servers_empty")}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="servers-list">
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
            // ping === 0 means "not measured yet" (initial state before the
            // probe lands). ping < 0 means the probe completed and failed —
            // the server is genuinely unreachable from this network. Block
            // the click in that case so the user can't kick off a VPN
            // switch that will tear down the current tunnel and then fail
            // to establish a new one (the "DNS resolve failed" cascade).
            const clickable = isAvailableVpnServer(server) && server.ping > 0;
            const selected =
              !automaticServerSelection &&
              clickable &&
              isSameServerSelection(selectedServer, server);
            const className = [
              "server-item",
              selected ? "server-item--selected" : "",
              !clickable ? "server-item--offline" : "",
            ].filter(Boolean).join(" ");

            return (
              <div
                key={server.id}
                className={className}
                aria-current={selected ? "true" : undefined}
                onClick={() => {
                  if (clickable) {
                    onSelect(server);
                  }
                }}
              >
                <span className="server-item__flag">
                  {flagsReady ? countryFlagForUi(server.country, server.name) : ""}
                </span>
                <div className="server-item__info">
                  <div className="server-item__name">
                    {serverDisplayName(server.name, server.country)}
                  </div>
                  <div className={`server-item__country ${!server.isOnline ? "server-item__country--red" : ""}`}>
                    {server.isOnline
                      ? countryName(serverCountryCodeForUi(server.country, server.name))
                      : t("server_unavailable")}
                  </div>
                </div>
                {!server.isOnline ? (
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
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
