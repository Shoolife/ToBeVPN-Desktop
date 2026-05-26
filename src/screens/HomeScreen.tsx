import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t, tf, getSavedLang, type StringKey } from "../i18n";
import SubscriptionSheet from "../components/SubscriptionSheet";
// UpdateBanner now mounts in App as a top-of-window overlay so it
// covers every screen, not only Home.
import {
  countryFlagForUi,
  serverCountryCodeForUi,
  serverDisplayName,
} from "../components/serverDisplay";
import { isSameServerSelection } from "../session/serverSelection";
import {
  fetchVpnServers,
  getSubscriptionUsageBlocked,
  pingHwidOnly,
  startPendingPurchaseRefreshIfNeeded,
  subscribeSubscriptionUsageBlocked,
  syncSubscription,
  type VpnServer,
} from "../session/auth";
import { useSession, type UserPlan } from "../session/store";
import { connectVpn, disconnectVpn, useVpnRuntime, clearVpnError } from "../session/vpnState";
import { preparePingBypass } from "../session/vpn";
import type { SelectedServer } from "../App";
import "./HomeScreen.css";

function countryName(code: string | null | undefined): string {
  if (!code) return "";
  const key = `country_${code.toUpperCase()}` as StringKey;
  return t(key) ?? code;
}

function pingColor(ping: number): string {
  if (ping < 100) return "#4CAF50";
  if (ping < 200) return "#FF9800";
  return "#F44336";
}

function planLabel(plan: UserPlan): string {
  switch (plan) {
    case "PAID":
      return t("plan_standard");
    case "ADMIN":
      return t("plan_admin");
    case "EXPIRED":
      return t("plan_expired");
    case "FREE_TRIAL":
    default:
      return t("plan_free");
  }
}

function planBadgeClass(plan: UserPlan): string {
  switch (plan) {
    case "PAID":
    case "ADMIN":
      return "home-sub__plan home-sub__plan--green";
    case "EXPIRED":
      return "home-sub__plan home-sub__plan--red";
    case "FREE_TRIAL":
    default:
      return "home-sub__plan home-sub__plan--orange";
  }
}

function formatSessionBytes(bytes: number): string {
  const isRu = getSavedLang() === "ru";
  const gb = isRu ? "ГБ" : "GB";
  const mb = isRu ? "МБ" : "MB";
  if (bytes < 1024 * 1024) return `0,00 ${mb}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${mb}`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ${gb}`;
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatTrafficBytes(bytes: number): string {
  const isRu = getSavedLang() === "ru";
  const gb = isRu ? "ГБ" : "GB";
  const mb = isRu ? "МБ" : "MB";
  if (bytes < 1024 * 1024) return `0 ${mb}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${mb}`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ${gb}`;
}

function trafficProgressColor(progress: number): string {
  if (progress >= 0.9) return "#F44336";
  if (progress >= 0.7) return "#FF9800";
  return "#4CAF50";
}

function planHint(plan: UserPlan, expiresAt: number | null): string {
  if (plan === "ADMIN") return t("plan_unlimited_access");
  if (expiresAt && plan === "PAID") {
    return tf("plan_until", new Date(expiresAt).toLocaleDateString());
  }
  if (plan === "FREE_TRIAL") return t("free_tier_hint");
  if (plan === "EXPIRED") return t("plan_expired");
  return "";
}

function toSelectedServer(server: VpnServer): SelectedServer {
  return {
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
  };
}

export default function HomeScreen({
  onLogout: _onLogout,
  onSettings,
  onServers,
  onStats,
  onSpeedTest,
  selectedServer,
  onServerChange,
}: {
  onLogout: () => void;
  onSettings: () => void;
  onServers: () => void;
  onStats: () => void;
  onSpeedTest: () => void;
  selectedServer: SelectedServer | null;
  onServerChange: (server: SelectedServer) => void;
}) {
  const session = useSession();
  const subscriptionUsageBlocked = useSyncExternalStore(
    subscribeSubscriptionUsageBlocked,
    getSubscriptionUsageBlocked,
    getSubscriptionUsageBlocked,
  );
  const vpn = useVpnRuntime();
  const { connected, connecting, disconnecting, sessionBytes, sessionStartTime, lastError } = vpn;
  const [showSubscription, setShowSubscription] = useState(false);
  const [showTrialInfo, setShowTrialInfo] = useState(false);
  const [showBlockedDialog, setShowBlockedDialog] = useState(false);
  const blockDialogShownOnce = useRef(false);
  const [checkingSubscriptionAccess, setCheckingSubscriptionAccess] = useState(false);
  const [preparingConnection, setPreparingConnection] = useState(false);
  const toggleGeneration = useRef(0);
  const activating = connecting || preparingConnection;

  const elapsed = sessionStartTime
    ? Math.floor((Date.now() - sessionStartTime) / 1000)
    : 0;

  // Ping for the selected server (refreshed when selection changes).
  const [ping, setPing] = useState(0);

  const isPaidOrAdmin = session.userPlan === "PAID" || session.userPlan === "ADMIN";

  useEffect(() => {
    void syncSubscription();
    startPendingPurchaseRefreshIfNeeded();

    const BLOCK_POLL_MS = 30_000;
    const checkBlock = () => void pingHwidOnly().catch(() => {});
    const timer = window.setInterval(checkBlock, BLOCK_POLL_MS);
    window.addEventListener("focus", checkBlock);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", checkBlock);
    };
  }, []);

  useEffect(() => {
    if (subscriptionUsageBlocked) {
      setShowSubscription(false);
      setShowTrialInfo(false);
      if (!blockDialogShownOnce.current) {
        blockDialogShownOnce.current = true;
        setShowBlockedDialog(true);
      }
    } else {
      blockDialogShownOnce.current = false;
      setShowBlockedDialog(false);
    }
  }, [subscriptionUsageBlocked]);

  const openSubscription = async () => {
    if (checkingSubscriptionAccess || subscriptionUsageBlocked) return;
    setCheckingSubscriptionAccess(true);
    try {
      if (!(await pingHwidOnly().catch(() => false))) {
        setShowSubscription(true);
      }
    } finally {
      setCheckingSubscriptionAccess(false);
    }
  };

  // Ping the selected server so the home card mirrors phone (latency on the right).
  useEffect(() => {
    if (!selectedServer) {
      setPing(0);
      return;
    }
    let cancelled = false;
    setPing(0);
    void (async () => {
      await preparePingBypass([selectedServer.address]).catch(() => {});
      if (cancelled) return;
      try {
        const ms = await invoke<number>("tcp_ping", {
          host: selectedServer.address,
          port: selectedServer.port,
          timeoutMs: 3000,
        });
        if (!cancelled) setPing(ms >= 0 ? ms : -1);
      } catch {
        if (!cancelled) setPing(-1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedServer]);

  const [localError, setLocalError] = useState<string | null>(null);
  const vpnError = localError ?? lastError;

  const prepareServerForConnect = async (): Promise<SelectedServer | null> => {
    if (!selectedServer) return null;
    if (isPaidOrAdmin) return selectedServer;

    await syncSubscription({ force: true }).catch(() => {});
    const freshServers = await fetchVpnServers().catch(() => []);
    const fresh =
      freshServers.find((server) => isSameServerSelection(selectedServer, server)) ??
      freshServers[0] ??
      null;
    if (!fresh) return null;

    const resolved = toSelectedServer(fresh);
    if (!isSameServerSelection(selectedServer, fresh)) {
      onServerChange(resolved);
    }
    return resolved;
  };

  const handleToggle = async () => {
    if (disconnecting) return;
    if (preparingConnection && !connecting && !connected) {
      toggleGeneration.current++;
      setPreparingConnection(false);
      return;
    }
    if (connected || activating) {
      toggleGeneration.current++;
      setPreparingConnection(false);
      try {
        await disconnectVpn();
      } catch (e) {
        console.error("[VPN-UI] disconnectVpn() error:", e);
      }
      return;
    }
    if (!selectedServer) {
      setLocalError(t("server_choose"));
      return;
    }
    setLocalError(null);
    clearVpnError();
    const generation = ++toggleGeneration.current;
    setPreparingConnection(true);
    try {
      const serverToConnect = await prepareServerForConnect();
      if (generation !== toggleGeneration.current) return;
      if (!serverToConnect) {
        setLocalError(t("servers_empty"));
        return;
      }
      const serverConfig = {
        address: serverToConnect.address,
        port: serverToConnect.port,
        uuid: serverToConnect.uuid,
        flow: serverToConnect.flow,
        security: serverToConnect.security,
        sni: serverToConnect.sni,
        fingerprint: serverToConnect.fingerprint,
        public_key: serverToConnect.public_key,
        short_id: serverToConnect.short_id,
        network: serverToConnect.network,
        path: serverToConnect.path,
        mode: serverToConnect.mode,
        spx: serverToConnect.spx,
      };
      await connectVpn(serverConfig);
    } catch (e) {
      console.error("[VPN-UI] connectVpn() error:", e);
    } finally {
      if (generation === toggleGeneration.current) {
        setPreparingConnection(false);
      }
    }
  };

  const statusText = activating
    ? t("state_connecting")
    : disconnecting
      ? t("state_disconnecting")
    : connected
      ? t("state_connected")
      : t("state_disconnected");

  const statusClass = activating
    ? "home__status-label--connecting"
    : disconnecting
      ? "home__status-label--disconnecting"
    : connected
      ? "home__status-label--on"
      : "";

  return (
    <div className="home-root">
      <div className="home-topbar">
        <div className="home-topbar__brand">
          <span className="home-topbar__title">ToBeVPN</span>
          <span className="home-topbar__partner">{t("app_partner")}</span>
        </div>
        <button className="home-topbar__btn" onClick={onSettings} title={t("settings")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      {!subscriptionUsageBlocked && session.userPlan === "FREE_TRIAL" && (
        <button
          className="home-trial-banner"
          type="button"
          onClick={() => setShowTrialInfo(true)}
        >
          <span className="home-trial-banner__icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </span>
          <span className="home-trial-banner__text">{t("trial_access_banner")}</span>
        </button>
      )}

      <div className="home-content">
        <div className="home-connect-area">
          <button
            className={`home-power ${connected ? "home-power--on" : ""} ${activating ? "home-power--connecting" : ""} ${disconnecting ? "home-power--disconnecting" : ""} ${subscriptionUsageBlocked ? "home-power--blocked" : ""}`}
            onClick={subscriptionUsageBlocked ? () => setShowBlockedDialog(true) : handleToggle}
          >
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
              <line x1="12" y1="2" x2="12" y2="12"/>
            </svg>
          </button>
          <div className={`home__status-label ${statusClass}`}>{statusText}</div>
          {vpnError && !subscriptionUsageBlocked && (
            <div className="home__vpn-error">{vpnError}</div>
          )}
        </div>

        {/* Server card */}
        <div className={`home-card ${subscriptionUsageBlocked ? "" : "home-card--clickable"}`} onClick={subscriptionUsageBlocked ? undefined : onServers}>
          <div className="home-card__row">
            {selectedServer ? (
              <span className="home-server__flag">
                {countryFlagForUi(selectedServer.country, selectedServer.name)}
              </span>
            ) : (
              <span className="home-card__icon home-card__icon--outline">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </span>
            )}
            <div className="home-card__info">
              <div className="home-card__title">
                {selectedServer
                  ? serverDisplayName(selectedServer.name, selectedServer.country)
                  : t("server_choose")}
              </div>
              {selectedServer && (
                <div className="home-card__subtitle">
                  {countryName(
                    serverCountryCodeForUi(
                      selectedServer.country,
                      selectedServer.name,
                    ),
                  )}
                </div>
              )}
            </div>
            {selectedServer && ping !== 0 && (
              <div className="home-card__ping">
                {ping > 0 ? (
                  <>
                    <span className="home-card__ping-value" style={{ color: pingColor(ping) }}>
                      {ping}
                    </span>
                    <span className="home-card__ping-unit">{t("speed_unit_ms")}</span>
                  </>
                ) : (
                  <span className="home-card__ping-unavailable">{t("server_unavailable")}</span>
                )}
              </div>
            )}
            <svg className="home-card__arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
        </div>

        {/* Current session card — mirrors phone's TrafficCard */}
        <div className="home-card home-card--clickable" onClick={onStats}>
          <div className="home-session__header">
            <span className="home-card__label">{t("current_session")}</span>
            <svg className="home-card__arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>

          {isPaidOrAdmin ? (
            <div className="home-session__metrics">
              <div className="home-session__metric">
                <div className="home-session__value">{formatSessionBytes(session.trafficUsedBytes + sessionBytes)}</div>
                <div className="home-session__label">{t("downloaded")}</div>
              </div>
              <div className="home-session__metric">
                <div className="home-session__value">{formatElapsed(elapsed)}</div>
                <div className="home-session__label">{t("session_time")}</div>
              </div>
            </div>
          ) : (
            <>
              <div className="home-traffic__row">
                <span className="home-traffic__label">{t("traffic")}</span>
                <span className="home-traffic__label">
                  {session.trafficLimitBytes > 0
                    ? `${formatTrafficBytes(session.trafficUsedBytes + sessionBytes)} / ${formatTrafficBytes(session.trafficLimitBytes)}`
                    : formatTrafficBytes(session.trafficUsedBytes + sessionBytes)}
                </span>
              </div>
              {session.trafficLimitBytes > 0 && (
                <div className="home-progress" style={{ marginTop: 6 }}>
                  <div
                    className="home-progress__fill"
                    style={{
                      width: `${Math.min(((session.trafficUsedBytes + sessionBytes) / session.trafficLimitBytes) * 100, 100)}%`,
                      background: trafficProgressColor((session.trafficUsedBytes + sessionBytes) / session.trafficLimitBytes),
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Speed test card */}
        <div className="home-card home-card--clickable" onClick={onSpeedTest}>
          <div className="home-card__row">
            <span className="home-card__bare-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"/>
              </svg>
            </span>
            <div className="home-card__info">
              <div className="home-card__title">{t("speed_test_title")}</div>
              <div className="home-card__subtitle">{t("speed_test_subtitle")}</div>
            </div>
            <svg className="home-card__arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
        </div>

        {/* Subscription card */}
        {subscriptionUsageBlocked ? (
          <div
            className="home-card home-card--clickable home-card--sub home-card--blocked"
            onClick={() => setShowBlockedDialog(true)}
          >
            <div className="home-card__row">
              <span className="home-card__blocked-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </span>
              <div className="home-card__info">
                <div className="home-sub__label">{t("subscription")}</div>
                <div className="home-sub__blocked-text">{t("usage_blocked")}</div>
              </div>
              <svg className="home-card__arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
          </div>
        ) : (
          <div
            className="home-card home-card--clickable home-card--sub"
            onClick={() => void openSubscription()}
          >
            <div className="home-card__row">
              <div className="home-card__info">
                <div className="home-sub__label">{t("subscription")}</div>
                <div className={planBadgeClass(session.userPlan)}>{planLabel(session.userPlan)}</div>
                <div className="home-sub__hint">
                  {checkingSubscriptionAccess
                    ? t("loading_data")
                    : planHint(session.userPlan, session.planExpiresAt)}
                </div>
              </div>
              <svg className="home-card__arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
          </div>
        )}
      </div>

      {showSubscription && !subscriptionUsageBlocked && (
        <SubscriptionSheet onDismiss={() => setShowSubscription(false)} />
      )}

      {showBlockedDialog && (
        <div className="home-trial-dialog-overlay" onClick={() => setShowBlockedDialog(false)}>
          <div className="home-trial-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="home-trial-dialog__header">
              <span className="home-trial-dialog__icon">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </span>
              <div className="home-trial-dialog__title">{t("usage_blocked")}</div>
            </div>
            <div className="home-trial-dialog__text">{t("block_appeal_message")}</div>
            <div className="home-trial-dialog__actions">
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--secondary"
                onClick={() => setShowBlockedDialog(false)}
              >
                OK
              </button>
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--primary"
                onClick={() => {
                  setShowBlockedDialog(false);
                  void openUrl("https://t.me/meow_meow_vpn?direct").catch(() => {});
                }}
              >
                {t("block_appeal_button")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTrialInfo && (
        <div className="home-trial-dialog-overlay" onClick={() => setShowTrialInfo(false)}>
          <div className="home-trial-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="home-trial-dialog__header">
              <span className="home-trial-dialog__icon">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </span>
              <div className="home-trial-dialog__title">{t("trial_access_title")}</div>
            </div>
            <div className="home-trial-dialog__text">{t("trial_access_description")}</div>
            <div className="home-trial-dialog__actions">
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--secondary"
                onClick={() => setShowTrialInfo(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--primary"
                onClick={() => {
                  setShowTrialInfo(false);
                  void openSubscription();
                }}
              >
                {t("trial_access_open_plans")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
