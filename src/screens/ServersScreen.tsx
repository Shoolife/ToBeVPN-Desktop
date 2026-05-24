import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t, type StringKey } from "../i18n";
import {
  countryFlagForUi,
  serverCountryCodeForUi,
  serverDisplayName,
} from "../components/serverDisplay";
import { fetchVpnServers, syncSubscription, type VpnServer } from "../session/auth";
import Spinner from "../components/Spinner";
import type { SelectedServer } from "../App";
import "./ServersScreen.css";

interface ServerItem extends VpnServer {
  ping: number;
}

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
}: {
  onBack: () => void;
  onSelect: (server: SelectedServer) => void;
}) {
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flagsReady, setFlagsReady] = useState(false);
  const pingGenRef = useRef(0);

  // Twemoji Country Flags is bundled via country-flag-emoji-polyfill but the
  // browser fetches/parses the woff2 asynchronously. If we render the list
  // before the font is ready, Windows momentarily shows raw "NL"/"RU" glyphs.
  // Gate the list on the font being fully loaded.
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) {
      setFlagsReady(true);
      return;
    }
    document.fonts
      .load('16px "Twemoji Country Flags"')
      .then(() => setFlagsReady(true))
      .catch(() => setFlagsReady(true)); // fail open: better letters than a stuck spinner
  }, []);

  const runPings = useCallback((items: ServerItem[], gen: number) => {
    for (const s of items) {
      if (!s.isOnline) continue;
      invoke<number>("tcp_ping", { host: s.address, port: s.port, timeoutMs: 3000 })
        .then((ms) => {
          if (pingGenRef.current !== gen) return;
          setServers((prev) =>
            prev.map((srv) => (srv.id === s.id ? { ...srv, ping: ms >= 0 ? ms : -1 } : srv)),
          );
        })
        .catch(() => {
          if (pingGenRef.current !== gen) return;
          setServers((prev) =>
            prev.map((srv) => (srv.id === s.id ? { ...srv, ping: -1 } : srv)),
          );
        });
    }
  }, []);

  const load = useCallback(async (opts: { force?: boolean } = {}) => {
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
      const items: ServerItem[] = vpnServers.map((s) => ({
        ...s,
        ping: 0,
      }));
      setServers(items);
      const gen = ++pingGenRef.current;
      runPings(items, gen);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, [runPings]);

  useEffect(() => {
    load();
  }, [load]);

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
      {loading || !flagsReady ? (
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
          {servers.map((server) => (
            <div
              key={server.id}
              className={`server-item ${!server.isOnline ? "server-item--offline" : ""}`}
              onClick={() => {
                if (server.isOnline) {
                  onSelect({
                    name: server.name,
                    country: server.country,
                    address: server.address,
                    port: server.port,
                    uuid: server.uuid,
                    flow: server.flow,
                    security: server.security,
                    sni: server.sni,
                    fingerprint: server.fingerprint,
                    public_key: server.public_key,
                    short_id: server.short_id,
                    network: server.network,
                    path: server.path,
                    mode: server.mode,
                    spx: server.spx,
                  });
                }
              }}
            >
              <span className="server-item__flag">
                {countryFlagForUi(server.country, server.name)}
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
          ))}
        </div>
      )}
    </div>
  );
}
