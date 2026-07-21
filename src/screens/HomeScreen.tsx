import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { exit } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t, tf, getSavedLang, type StringKey } from "../i18n";
import SubscriptionSheet from "../components/SubscriptionSheet";
import {
  forceCheckUpdate,
  retryUpdate,
  startUpdateDownload,
  useUpdateState,
} from "../session/updateStore";
// UpdateBanner now mounts in App as a top-of-window overlay so it
// covers every screen, not only Home.
import {
  countryFlagForUi,
  serverCountryCodeForUi,
  serverDisplayName,
} from "../components/serverDisplay";
import { hasSameVpnConfig, isSameServerSelection } from "../session/serverSelection";
import {
  fetchVpnServers,
  getSubscriptionUsageBlocked,
  getUpdateRequired,
  isAvailableVpnServer,
  pingHwidOnly,
  startPendingPurchaseRefreshIfNeeded,
  subscribeSubscriptionUsageBlocked,
  syncSubscription,
  type VpnServer,
} from "../session/auth";
import { getSession, useSession, type UserPlan } from "../session/store";
import { connectVpn, disconnectVpn, useVpnRuntime, clearVpnError } from "../session/vpnState";
import {
  measureVpnServerPing,
  selectBestVpnServer,
} from "../session/serverQuality";
import { stableServerId } from "../session/serverSelection";
import { formatDateDots } from "../session/dateFormat";
import type { SelectedServer } from "../App";
import "./HomeScreen.css";

function countryName(code: string | null | undefined): string {
  if (!code) return "";
  const key = `country_${code.toUpperCase()}` as StringKey;
  return t(key) ?? code;
}

function pingColor(ping: number): string {
  if (ping < 100) return "var(--success)";
  if (ping < 200) return "var(--warning)";
  return "var(--danger)";
}

function planLabel(plan: UserPlan, displayName?: string | null): string {
  if (displayName && plan !== "EXPIRED") return displayName;
  switch (plan) {
    case "PAID":
      return t("plan_unknown_name");
    case "ADMIN":
      return t("plan_unknown_name");
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
  if (progress >= 0.9) return "var(--danger)";
  if (progress >= 0.7) return "var(--warning)";
  return "var(--success)";
}

function planHint(plan: UserPlan, expiresAt: number | null): string {
  if (expiresAt && (plan === "PAID" || plan === "ADMIN")) {
    return tf("plan_until", formatDateDots(expiresAt));
  }
  if (plan === "FREE_TRIAL") return t("free_tier_hint");
  if (plan === "EXPIRED") return t("plan_expired");
  return "";
}

const SUBSCRIPTION_REMINDER_DAY_MS = 86_400_000;

function ruDayWord(days: number): string {
  const mod10 = days % 10;
  const mod100 = days % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

function expiringSubscriptionTitle(daysLeft: number): string {
  if (daysLeft <= 0) return t("subscription_expiry_today");
  if (getSavedLang() === "ru") {
    return `${t("subscription_expiring_prefix")} ${daysLeft} ${ruDayWord(daysLeft)}`;
  }
  return `${t("subscription_expiring_prefix")} ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`;
}

function subscriptionReminder(plan: UserPlan, expiresAt: number | null): { title: string; expired: boolean } | null {
  if (plan === "EXPIRED") {
    return { title: t("subscription_expired_title"), expired: true };
  }
  if (plan !== "PAID" || expiresAt === null) return null;
  const msLeft = expiresAt - Date.now();
  if (msLeft < 0 || msLeft > 3 * SUBSCRIPTION_REMINDER_DAY_MS) return null;
  return {
    title: expiringSubscriptionTitle(Math.ceil(msLeft / SUBSCRIPTION_REMINDER_DAY_MS)),
    expired: false,
  };
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

function canUseSelectedServerFallback(server: SelectedServer | null): server is SelectedServer {
  const session = getSession();
  return Boolean(
    server &&
      !getSubscriptionUsageBlocked() &&
      session.userPlan !== "EXPIRED" &&
      server.uuid !== "00000000-0000-0000-0000-000000000000" &&
      server.address &&
      server.address !== "127.0.0.1" &&
      server.address !== "0.0.0.0",
  );
}

let blockDialogShownThisSession = false;

export default function HomeScreen({
  onLogout: _onLogout,
  onSettings,
  onServers,
  onStats,
  onSpeedTest,
  selectedServer,
  automaticServerSelection,
  autostartConnectRequested = false,
  onAutostartConnectHandled,
  browserPreview = false,
  onServerChange,
}: {
  onLogout: () => void;
  onSettings: () => void;
  onServers: () => void;
  onStats: () => void;
  onSpeedTest: () => void;
  selectedServer: SelectedServer | null;
  automaticServerSelection: boolean;
  autostartConnectRequested?: boolean;
  onAutostartConnectHandled?: () => void;
  browserPreview?: boolean;
  onServerChange: (server: SelectedServer) => void;
}) {
  const session = useSession();
  const subscriptionUsageBlocked = useSyncExternalStore(
    subscribeSubscriptionUsageBlocked,
    getSubscriptionUsageBlocked,
    getSubscriptionUsageBlocked,
  );
  const updateRequired = useSyncExternalStore(
    subscribeSubscriptionUsageBlocked,
    getUpdateRequired,
    getUpdateRequired,
  );
  const vpn = useVpnRuntime();
  const { connected, connecting, disconnecting, sessionBytes, sessionStartTime, lastError } = vpn;
  const previewSubscriptionOpen =
    browserPreview && new URLSearchParams(window.location.search).get("subscription") === "1";
  const [showSubscription, setShowSubscription] = useState(previewSubscriptionOpen);
  const [showTrialInfo, setShowTrialInfo] = useState(false);
  const [showBlockedDialog, setShowBlockedDialog] = useState(false);
  const [dismissedReminderKey, setDismissedReminderKey] = useState<string | null>(null);
  const prevBlocked = useRef(subscriptionUsageBlocked);
  const [checkingSubscriptionAccess, setCheckingSubscriptionAccess] = useState(false);
  const [preparingConnection, setPreparingConnection] = useState(false);
  const toggleGeneration = useRef(0);
  const autostartConnectHandled = useRef(false);
  const activating = connecting || preparingConnection;

  const elapsed = sessionStartTime
    ? Math.floor((Date.now() - sessionStartTime) / 1000)
    : 0;

  // Ping for the selected server (refreshed when selection changes).
  const [ping, setPing] = useState(0);

  const reminder = subscriptionReminder(session.userPlan, session.planExpiresAt);
  const reminderKey = `${session.userPlan}:${session.planExpiresAt ?? ""}`;
  const showSubscriptionReminder =
    !subscriptionUsageBlocked &&
    reminder !== null &&
    dismissedReminderKey !== reminderKey;
  const subscriptionTrafficUsedBytes = Math.max(0, session.trafficUsedBytes);
  const subscriptionTrafficLimitBytes = Math.max(0, session.trafficLimitBytes);
  const hasSubscriptionTrafficLimit = subscriptionTrafficLimitBytes > 0;
  const subscriptionTrafficProgress = hasSubscriptionTrafficLimit
    ? Math.min(subscriptionTrafficUsedBytes / subscriptionTrafficLimitBytes, 1)
    : 0;

  useEffect(() => {
    if (browserPreview) return;
    // Force-sync on mount so the block state lands before the user can act,
    // bypassing the 12h throttle of the unforced syncSubscription.
    void syncSubscription({ force: true }).catch(() => {});
    // Do not make the first server refresh wait for the bot sync above. The
    // subscription endpoint is authoritative for server availability. Reuse
    // the access ping instead of issuing it twice inside fetchVpnServers().
    void pingHwidOnly()
      .then((blocked) => blocked ? [] : fetchVpnServers({ skipAccessPing: true }))
      .catch(() => []);
    startPendingPurchaseRefreshIfNeeded();

    const BLOCK_POLL_MS = 30_000;
    const checkBlock = () => void pingHwidOnly().catch(() => {});
    const timer = window.setInterval(checkBlock, BLOCK_POLL_MS);
    window.addEventListener("focus", checkBlock);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", checkBlock);
    };
  }, [browserPreview]);

  useEffect(() => {
    if (subscriptionUsageBlocked) {
      setShowSubscription(false);
      setShowTrialInfo(false);
      // Show dialog automatically only:
      // 1. First time this session (app startup) — blockDialogShownThisSession is false
      // 2. Real-time transition: was unblocked → now blocked (prevBlocked was false)
      // NOT on re-mount (navigating back from Settings/Stats).
      const isRealTimeTransition = !prevBlocked.current;
      if (!blockDialogShownThisSession || isRealTimeTransition) {
        blockDialogShownThisSession = true;
        setShowBlockedDialog(true);
      }
    } else {
      setShowBlockedDialog(false);
    }
    prevBlocked.current = subscriptionUsageBlocked;
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
    if (browserPreview) {
      setPing(0);
      return;
    }
    if (!selectedServer) {
      setPing(0);
      return;
    }
    let cancelled = false;
    setPing(0);
    void (async () => {
      const pingServer: VpnServer = {
        ...selectedServer,
        id: stableServerId(selectedServer),
        isOnline: true,
        sortOrder: 0,
      };
      const ms = await measureVpnServerPing(pingServer, { force: true });
      if (!cancelled) setPing(ms);
    })();
    return () => {
      cancelled = true;
    };
  }, [browserPreview, selectedServer]);

  const [localError, setLocalError] = useState<string | null>(null);
  const vpnError = localError ?? lastError;

  const prepareServerForConnect = async (): Promise<SelectedServer | null> => {
    if (!automaticServerSelection && !selectedServer) return null;

    // Refresh plan metadata in the background; direct subscription access is
    // sufficient to validate and refresh the server used for this connection.
    void syncSubscription({ force: true }).catch(() => {});
    let freshServers: VpnServer[];
    try {
      freshServers = (await fetchVpnServers()).filter(isAvailableVpnServer);
    } catch (error) {
      // Stale selection is an offline fallback only. A successful empty
      // response means access or that endpoint was removed.
      if (canUseSelectedServerFallback(selectedServer)) {
        console.warn("[VPN-UI] server refresh failed; using cached selection", error);
        return selectedServer;
      }
      return null;
    }
    const fresh = automaticServerSelection
      ? await selectBestVpnServer(freshServers, { forceProbe: true })
      : freshServers.find((server) => isSameServerSelection(selectedServer, server)) ?? null;
    if (!fresh) {
      return null;
    }
    if (!automaticServerSelection) {
      void measureVpnServerPing(fresh, { force: true }).catch(() => -1);
    }

    const resolved = toSelectedServer(fresh);
    if (!hasSameVpnConfig(selectedServer, resolved)) {
      onServerChange(resolved);
    }
    return resolved;
  };

  const startConnection = async () => {
    if (!selectedServer && !automaticServerSelection) {
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

  const handleToggle = async () => {
    if (browserPreview) return;
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
    await startConnection();
  };

  useEffect(() => {
    if (!autostartConnectRequested) {
      autostartConnectHandled.current = false;
      return;
    }
    if (autostartConnectHandled.current) return;
    autostartConnectHandled.current = true;
    onAutostartConnectHandled?.();

    // Reuse the same preparation path as the power button, but never toggle
    // an existing/in-flight connection off when an autostart request arrives.
    if (
      browserPreview ||
      subscriptionUsageBlocked ||
      updateRequired ||
      connected ||
      connecting ||
      disconnecting ||
      preparingConnection
    ) {
      return;
    }
    void startConnection();
  }, [autostartConnectRequested]);

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

      {showSubscriptionReminder && reminder && (
        <div className={`home-sub-reminder ${reminder.expired ? "home-sub-reminder--expired" : ""}`}>
          <div className="home-sub-reminder__header">
            <div className="home-sub-reminder__icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div className="home-sub-reminder__body">
              <div className="home-sub-reminder__title">{reminder.title}</div>
              <div className="home-sub-reminder__text">{t("subscription_renew_reminder_desc")}</div>
            </div>
          </div>
          <div className="home-sub-reminder__actions">
            <button
              className="home-sub-reminder__btn home-sub-reminder__btn--primary"
              onClick={() => void openSubscription()}
            >
              {t("subscription_renew_action")}
            </button>
            <button
              className="home-sub-reminder__btn home-sub-reminder__btn--text"
              onClick={() => setDismissedReminderKey(reminderKey)}
            >
              {t("update_banner_later")}
            </button>
          </div>
        </div>
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
            {selectedServer && !subscriptionUsageBlocked ? (
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
                {selectedServer && !subscriptionUsageBlocked
                  ? serverDisplayName(selectedServer.name, selectedServer.country)
                  : t("server_choose")}
              </div>
              {selectedServer && !subscriptionUsageBlocked && (
                <div className="home-card__subtitle">
                  {automaticServerSelection
                    ? t("server_auto_selected")
                    : countryName(
                        serverCountryCodeForUi(
                          selectedServer.country,
                          selectedServer.name,
                        ),
                      )}
                </div>
              )}
            </div>
            {selectedServer && !subscriptionUsageBlocked && ping !== 0 && (
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

          <div className="home-session__metrics">
            <div className="home-session__metric">
              <div className="home-session__value">{formatSessionBytes(sessionBytes)}</div>
              <div className="home-session__label">{t("traffic")}</div>
            </div>
            <div className="home-session__metric">
              <div className="home-session__value">{formatElapsed(elapsed)}</div>
              <div className="home-session__label">{t("session_time")}</div>
            </div>
          </div>
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
                <div className={planBadgeClass(session.userPlan)}>
                  {planLabel(session.userPlan, session.planDisplayName)}
                </div>
                <div className="home-sub__hint">
                  {checkingSubscriptionAccess
                    ? t("loading_data")
                    : planHint(session.userPlan, session.planExpiresAt)}
                </div>
              </div>
              {hasSubscriptionTrafficLimit && (
                <div className="home-sub-usage" aria-label={t("traffic")}>
                  <div
                    className="home-sub-usage__value"
                    title={`${formatTrafficBytes(subscriptionTrafficUsedBytes)} / ${formatTrafficBytes(subscriptionTrafficLimitBytes)}`}
                  >
                    {formatTrafficBytes(subscriptionTrafficUsedBytes)} / {formatTrafficBytes(subscriptionTrafficLimitBytes)}
                  </div>
                  <div className="home-sub-usage__progress">
                    <div
                      className="home-sub-usage__fill"
                      style={{
                        width: `${subscriptionTrafficProgress * 100}%`,
                        background: trafficProgressColor(subscriptionTrafficProgress),
                      }}
                    />
                  </div>
                </div>
              )}
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
          <div className="home-trial-dialog home-trial-dialog--centered" onClick={(e) => e.stopPropagation()}>
            <button className="home-trial-dialog__close" onClick={() => setShowBlockedDialog(false)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <span className="home-trial-dialog__icon home-trial-dialog__icon--top">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <div className="home-trial-dialog__title">{t("usage_blocked")}</div>
            <div className="home-trial-dialog__text">{t("block_appeal_message")}</div>
            <div className="home-trial-dialog__actions home-trial-dialog__actions--centered">
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

      {updateRequired && <UpdateRequiredDialog />}
    </div>
  );
}

function UpdateRequiredDialog() {
  const updateState = useUpdateState();

  const handleUpdate = async () => {
    if (updateState.kind !== "available") {
      await forceCheckUpdate();
    }
    await startUpdateDownload();
  };

  const downloading = updateState.kind === "downloading";
  const ready = updateState.kind === "ready";
  const failed = updateState.kind === "failed";

  const fraction =
    downloading && updateState.progress.total > 0
      ? Math.min(updateState.progress.downloaded / updateState.progress.total, 1)
      : 0;
  const downloadedMb = downloading
    ? (updateState.progress.downloaded / (1024 * 1024)).toFixed(1)
    : "0.0";
  const totalMb =
    downloading && updateState.progress.total > 0
      ? (updateState.progress.total / (1024 * 1024)).toFixed(1)
      : null;
  const indeterminate = downloading && updateState.progress.indeterminate;

  return (
    <div className="home-trial-dialog-overlay home-trial-dialog-overlay--modal">
      <div className="home-trial-dialog home-trial-dialog--centered">
        <span className="home-trial-dialog__icon home-trial-dialog__icon--top home-trial-dialog__icon--update">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </span>

        {downloading ? (
          <>
            <div className="home-trial-dialog__title">
              {t("update_banner_downloading_title").replace("{version}", updateState.info.version)}
            </div>
            <div
              className={
                indeterminate
                  ? "update-banner__progress update-banner__progress--indeterminate"
                  : "update-banner__progress"
              }
              style={{ marginTop: 16, width: "100%" }}
            >
              <div
                className="update-banner__progress-fill"
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
            <div className="home-trial-dialog__text">
              {indeterminate
                ? t("update_banner_installing_privileged")
                : totalMb
                  ? tf("update_banner_progress_of", downloadedMb, totalMb)
                  : tf("update_banner_progress", downloadedMb)}
            </div>
          </>
        ) : ready ? (
          <>
            <div className="home-trial-dialog__title">
              {t("update_banner_ready_title").replace("{version}", updateState.info.version)}
            </div>
            <div className="home-trial-dialog__text">
              {t("update_banner_ready_description")}
            </div>
          </>
        ) : failed ? (
          <>
            <div className="home-trial-dialog__title">
              {t("update_banner_failed_title")}
            </div>
            {updateState.reason && (
              <div className="home-trial-dialog__text">{updateState.reason.slice(0, 200)}</div>
            )}
            <div className="home-trial-dialog__actions home-trial-dialog__actions--centered">
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--secondary"
                onClick={() => void exit(0)}
              >
                {t("update_required_quit")}
              </button>
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--primary"
                onClick={retryUpdate}
              >
                {t("update_banner_retry")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="home-trial-dialog__title">{t("update_required_title")}</div>
            <div className="home-trial-dialog__text">{t("update_required_message")}</div>
            <div className="home-trial-dialog__actions home-trial-dialog__actions--centered">
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--secondary"
                onClick={() => void exit(0)}
              >
                {t("update_required_quit")}
              </button>
              <button
                className="home-trial-dialog__btn home-trial-dialog__btn--primary"
                onClick={() => void handleUpdate()}
              >
                {t("update_required_button")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
