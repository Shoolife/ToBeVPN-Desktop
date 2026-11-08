import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatDecimal, t, tf, type StringKey } from "../i18n";
import { countryFlagForUi, serverDisplayName } from "../components/serverDisplay";
import { periodRanges } from "../session/stats";
import { useRouterTraffic } from "../session/useRouterTraffic";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import Spinner from "../components/Spinner";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import { useAnimatedDialogClose } from "../components/useAnimatedDialogClose";
import "../components/SubscriptionSheet.css";
import "../components/WhatsNewDialog.css";
import { createPortal } from "react-dom";
import { getCachedVpnServers, isAvailableVpnServer, type VpnServer } from "../session/auth";
import { measureVpnServerPings } from "../session/serverQuality";
import { serverProfileConfig } from "../session/vpn";
import {
  accountSubscriptionUrl,
  defaultRouterUser,
  detectRouter,
  getCachedRouter,
  getRouterLink,
  installRouter,
  routerControl,
  routerFirmwareLabel,
  routerStatus,
  setRouterServers,
  setRouterName,
  refreshRouterTraffic,
  routerTrafficBetween,
  routerDeviceLabel,
  unlinkRouterFromAccount,
  cachedLanNames,
  discoverLanNames,
  ROUTER_MAX_SERVERS,
  routerServerLimit,
  routerDevices,
  setRouterDefaultMode,
  setRouterDevice,
  type RouterAction,
  type RouterDevice,
  type RouterInfo,
  type RouterLink,
  type RouterNetwork,
  type RouterStatus,
  type SlotServer,
} from "../session/router";
import "./DevicesScreen.css";
import "./RouterScreen.css";

const MIN_REFRESH_FEEDBACK_MS = 800;
/** As on the subscription sheet: its slide-down and drag threshold. */
const SHEET_CLOSE_MS = 300;
const SHEET_DRAG_ACTIVATION_PX = 9;

export function RouterIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <line x1="6" y1="17" x2="6.01" y2="17" />
      <line x1="10" y1="17" x2="10.01" y2="17" />
      <path d="M12 13V9" />
      <path d="M8.5 6.5a5 5 0 0 1 7 0" />
      <path d="M6 4a8.5 8.5 0 0 1 12 0" />
    </svg>
  );
}

/** One line under the router name: firmware family and address. */
export function routerMeta(info: RouterInfo): string {
  return [routerFirmwareLabel(info.firmware), info.gateway].filter(Boolean).join(" · ");
}

const INSTALL_STEPS: Record<string, StringKey> = {
  connect: "router_step_connect",
  check: "router_step_check",
  tun: "router_step_tun",
  "download:xray": "router_step_download",
  "download:hev-socks5-tunnel": "router_step_download",
  "upload:xray": "router_step_upload",
  "upload:hev-socks5-tunnel": "router_step_upload",
  configure: "router_step_configure",
  start: "router_step_start",
  done: "router_step_done",
};

/** A readable message for errors from the native router commands. */
function routerErrorText(error: unknown): string {
  const raw = String(error ?? "");
  if (raw.includes("wrong router login or password")) return t("router_error_password");
  if (raw.includes("did not answer on SSH")) return t("router_error_ssh");
  if (raw.includes("host key changed")) return t("router_error_host_key");
  if (raw.includes("not enough space")) return t("router_error_space");
  if (raw.includes("unsupported router CPU") || raw.includes("no TUN support")) return t("router_error_unsupported");
  if (raw.includes("not paired") || raw.includes("rejected the app key")) return t("router_error_not_paired");
  return tf("router_error_generic", raw.replace(/^Error:\s*/, "").slice(0, 200));
}

interface InstallLogLine {
  level: "step" | "info" | "warn" | "error";
  text: string;
  time: string;
}

/** Full install log: every step, check, download attempt and error. */
function InstallLog({ lines, open, onToggle }: { lines: InstallLogLine[]; open: boolean; onToggle: () => void }) {
  const [copied, setCopied] = useState(false);
  const linesRef = useRef<HTMLDivElement>(null);
  // Follow new lines, so the latest step or error is in view.
  useEffect(() => {
    const element = linesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length, open]);
  const errors = lines.filter((line) => line.level === "error").length;
  const lineText = (line: InstallLogLine) =>
    line.level === "step" && INSTALL_STEPS[line.text] ? `— ${t(INSTALL_STEPS[line.text])}` : line.text;
  const copy = () => {
    const text = lines.map((line) => `${line.time} ${line.level.toUpperCase()} ${lineText(line)}`).join("\n");
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="router-log">
      <div className="router-log__bar">
        <button type="button" className="router-link" onClick={onToggle} aria-expanded={open}>
          {open ? t("router_log_hide") : tf("router_log_show", lines.length)}
        </button>
        {errors > 0 && !open && <span className="router-log__errors">{tf("router_log_errors", errors)}</span>}
        {open && (
          <button type="button" className="router-link" onClick={copy}>
            {copied ? t("router_log_copied") : t("router_log_copy")}
          </button>
        )}
      </div>
      {open && (
        <div ref={linesRef} className="router-log__lines" role="log">
          {lines.map((line, index) => (
            <div key={index} className={`router-log__line router-log__line--${line.level}`}>
              <span className="router-log__time">{line.time}</span> {lineText(line)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function routableServers(): VpnServer[] {
  return getCachedVpnServers().filter(isAvailableVpnServer);
}

function slotServer(slot: number, server: VpnServer): SlotServer {
  return { slot, id: server.id, name: server.name, server: serverProfileConfig(server) };
}


/** Slots that devices other than `exceptMac` go through. */
function usedSlots(network: RouterNetwork, exceptMac?: string): Set<number> {
  return new Set(
    network.devices
      .filter((device) => device.mac !== exceptMac && device.mode === "vpn")
      .map((device) => device.slot),
  );
}

/**
 * Where a device's server goes. A server already on the router keeps its
 * slot (`list` null: nothing to rewrite); otherwise it takes a free slot and
 * `list` is the router's new server list: the slots still in use plus this
 * one. Slot 0 always has a server, since the router's first tunnel needs one.
 */
function planSlots(
  servers: VpnServer[],
  network: RouterNetwork,
  exceptMac: string,
  serverId: string,
  limit: number,
): { list: SlotServer[] | null; slot: number } | "full" | null {
  const present = network.slots.find((item) => item.serverId === serverId);
  if (present) return { list: null, slot: present.slot };
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) return null;
  const used = usedSlots(network, exceptMac);
  const list: SlotServer[] = [];
  for (const item of network.slots) {
    if (!used.has(item.slot)) continue;
    const kept = servers.find((candidate) => candidate.id === item.serverId);
    if (kept) list.push(slotServer(item.slot, kept));
  }
  if (list.length >= limit) return "full";
  const taken = new Set(list.map((item) => item.slot));
  const free = Array.from({ length: ROUTER_MAX_SERVERS }, (_, slot) => slot).find((slot) => !taken.has(slot));
  if (free === undefined) return "full";
  list.push(slotServer(free, server));
  return { list: list.sort((x, y) => x.slot - y.slot), slot: free };
}

/** Whether a server not yet on the router still fits for this device. */
function canAddServer(servers: VpnServer[], network: RouterNetwork, exceptMac: string, limit: number): boolean {
  const used = usedSlots(network, exceptMac);
  const kept = network.slots.filter(
    (item) => used.has(item.slot) && servers.some((server) => server.id === item.serverId),
  );
  return kept.length < limit;
}

/** Server for a fresh install: the fastest answer, else the first one. */
function installServer(servers: VpnServer[], pings: Map<string, number>): VpnServer | null {
  const answered = servers.filter((server) => (pings.get(server.id) ?? -1) >= 0);
  answered.sort((x, y) => (pings.get(x.id) ?? 0) - (pings.get(y.id) ?? 0));
  return answered[0] ?? servers[0] ?? null;
}

export default function RouterScreen({ onBack }: { onBack: () => void }) {
  const [info, setInfo] = useState<RouterInfo | null>(() => getCachedRouter());
  const [link, setLink] = useState<RouterLink | null>(() => getRouterLink());
  const [status, setStatus] = useState<RouterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [autostart, setAutostart] = useState(true);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  // Read again on every load: the server list may arrive after the screen opens.
  const [servers, setServers] = useState<VpnServer[]>(routableServers);
  const [network, setNetwork] = useState<RouterNetwork | null>(null);
  const [logLines, setLogLines] = useState<InstallLogLine[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [pings, setPings] = useState<Map<string, number>>(new Map());
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const generationRef = useRef(0);

  const load = async (refresh: boolean) => {
    const generation = ++generationRef.current;
    const startedAt = performance.now();
    setRefreshing(refresh);
    setError(null);
    const nextInfo = await detectRouter(refresh);
    const currentLink = getRouterLink();
    let nextStatus: RouterStatus | null = null;
    if (currentLink) {
      try {
        nextStatus = await routerStatus(currentLink);
      } catch (statusError) {
        if (generation === generationRef.current) setError(routerErrorText(statusError));
      }
    }
    if (refresh) {
      const remaining = MIN_REFRESH_FEEDBACK_MS - (performance.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
    }
    if (generation !== generationRef.current) return;
    if (refresh && currentLink) void refreshRouterTraffic(0);
    const nextServers = routableServers();
    setServers(nextServers);
    void measureVpnServerPings(nextServers, { force: refresh })
      .then((measured) => {
        if (generation === generationRef.current) setPings(measured);
      })
      .catch(() => undefined);
    setInfo(nextInfo);
    setLink(currentLink);
    setStatus(nextStatus);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    void load(false);
    const unlisten = listen<string>("router-install-progress", (event) => setStep(event.payload));
    const unlistenLog = listen<{ level: InstallLogLine["level"]; text: string }>("router-install-log", (event) => {
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setLogLines((lines) => [...lines, { ...event.payload, time }].slice(-500));
      if (event.payload.level === "error") setLogOpen(true);
    });
    return () => {
      generationRef.current += 1;
      void unlisten.then((stop) => stop());
      void unlistenLog.then((stop) => stop());
    };
  }, []);

  const selectedServer = installServer(servers, pings);

  const handleInstall = async () => {
    const subscriptionUrl = accountSubscriptionUrl();
    if (!info?.gateway || !selectedServer || !subscriptionUrl || !password) return;
    setBusy(true);
    setError(null);
    setLogLines([]);
    setStep("connect");
    try {
      const next = await installRouter({
        host: info.gateway,
        user: user.trim() || defaultRouterUser(info),
        password,
        server: slotServer(0, selectedServer),
        subscriptionUrl,
        autostart,
      });
      setStatus(next);
      setLink(getRouterLink());
      setFormOpen(false);
    } catch (installError) {
      setError(routerErrorText(installError));
    } finally {
      setPassword("");
      setPasswordVisible(false);
      setBusy(false);
      setStep(null);
    }
  };

  const runAction = async (action: RouterAction) => {
    if (!link) return;
    setBusy(true);
    setError(null);
    try {
      const next = await routerControl(link, action);
      setConfirmUninstall(false);
      if (action === "uninstall") {
        setLink(null);
        setStatus(null);
      } else {
        setStatus(next);
      }
    } catch (actionError) {
      setError(routerErrorText(actionError));
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!link) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await setRouterName(link, nameDraft.trim()));
      setLink(getRouterLink());
      setRenaming(false);
    } catch (nameError) {
      setError(routerErrorText(nameError));
    } finally {
      setBusy(false);
    }
  };

  const installed = !!link && !!status?.installed;
  const detected = !!info?.model;
  const statusText = !info?.gateway
    ? t("router_status_no_network")
    : info.supported
      ? t("router_status_supported")
      : info.firmware
        ? t("router_status_openwrt_unverified")
        : t("router_status_unknown");

  return (
    <div className="devices-root">
      <div className="devices-topbar">
        <button className="devices-topbar__back" onClick={onBack} aria-label={t("back")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="devices-topbar__title">{t("router_title")}</span>
        <TopbarRefreshButton
          label={t("refresh")}
          loading={loading || refreshing}
          onClick={() => void load(true)}
          disabled={loading || refreshing || busy}
        />
      </div>

      {loading || !info ? (
        <div className="spinner-center devices-spinner">
          <Spinner size={32} />
        </div>
      ) : refreshing ? (
        <ScrollEdgeAffordance className="router-content" overlayFade>
          <RouterSkeleton installed={!!link} />
        </ScrollEdgeAffordance>
      ) : (
        <ScrollEdgeAffordance className="router-content" overlayFade>
          <div className="devices-card devices-card--current">
            <div className="devices-card__icon"><RouterIcon /></div>
            <div className="devices-card__info">
              {installed && renaming ? (
                <form
                  className="router-device__rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveName();
                  }}
                >
                  <input
                    value={nameDraft}
                    maxLength={40}
                    autoFocus
                    disabled={busy}
                    placeholder={t("router_name_placeholder")}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenaming(false);
                    }}
                  />
                  <button type="submit" className="router-link" disabled={busy}>{t("router_rename_save")}</button>
                </form>
              ) : installed ? (
                <button
                  type="button"
                  className="router-device__name router-card__name"
                  aria-label={t("router_rename_hint")}
                  disabled={busy}
                  onClick={() => {
                    setNameDraft(status?.name ?? "");
                    setRenaming(true);
                  }}
                >
                  <span className="router-device__label">{status?.name || info.model || t("router_title")}</span>
                  <svg className="router-card__pencil" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              ) : (
                <div className="devices-card__name">{detected ? info.model : t("router_not_detected")}</div>
              )}
              {routerMeta(info) && (
                <div className="devices-card__meta">
                  {installed && status?.name && info.model ? `${info.model} · ` : ""}
                  {routerMeta(info)}
                </div>
              )}
            </div>
            {installed ? (
              <span className={`router-state ${status?.running ? "router-state--on" : ""}`}>
                {status?.running ? t("router_state_running") : t("router_state_stopped")}
              </span>
            ) : (
              info.supported && <span className="devices-card__badge">{t("router_supported_badge")}</span>
            )}
          </div>
          {!installed && <p className="router-status">{statusText}</p>}
          {installed && status?.failed && !status.running && <p className="router-error">{t("router_failed")}</p>}
          {installed && status?.running && status.downSlots.length > 0 && (
            <p className="router-error">{t("router_server_down")}</p>
          )}
          {error && <p className="router-error">{error}</p>}

          {installed && status ? (
            <>
              <div className="devices-section-title">{t("router_traffic_title")}</div>
              <RouterTraffic />

              <div className="devices-section-title">{t("router_home_network_section")}</div>
              {link && (
                <HomeNetwork
                  link={link}
                  status={status}
                  servers={servers}
                  pings={pings}
                  network={network}
                  disabled={busy}
                  onBusy={setBusy}
                  onNetwork={setNetwork}
                  onStatus={setStatus}
                  onError={setError}
                />
              )}

              <div className="devices-section-title">{t("router_controls_section")}</div>
              <div className="router-panel">
                <button
                  type="button"
                  className="router-row router-row--toggle"
                  disabled={busy}
                  onClick={() => void runAction(status.autostart ? "autostart-off" : "autostart-on")}
                >
                  <span>{t("router_autostart")}</span>
                  <span className={`settings-switch ${status.autostart ? "settings-switch--on" : ""}`} role="switch" aria-checked={status.autostart}>
                    <span className="settings-switch__thumb" />
                  </span>
                </button>
              </div>

              <div className="router-bottom">
                {(
                  <div className="router-bottom__buttons">
                    <button
                      type="button"
                      className="router-button"
                      disabled={busy}
                      onClick={() => void runAction(status.running ? "stop" : "start")}
                    >
                      {status.running ? t("router_stop") : t("router_start")}
                    </button>
                    <button type="button" className="router-button router-button--danger" disabled={busy} onClick={() => setConfirmUninstall(true)}>
                      {t("router_uninstall_short")}
                    </button>
                  </div>
                )}
                {busy && <Spinner size={18} />}
              </div>
              {confirmUninstall && link && (
                <UninstallSheet
                  link={link}
                  hwid={status.hwid ?? link.hwid ?? null}
                  onClose={() => setConfirmUninstall(false)}
                  onRemoved={() => {
                    setLink(null);
                    setStatus(null);
                    setNetwork(null);
                  }}
                />
              )}
            </>
          ) : (
            <>
              <div className="devices-section-title">{t("router_vpn_section")}</div>
              <div className="router-panel">
                <p className="router-panel__text">{t("router_vpn_description")}</p>
                {formOpen ? (
                  <form
                    className="router-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleInstall();
                    }}
                  >
                    <label className="router-field">
                      <span>{t("router_login")}</span>
                      <input
                        value={user}
                        placeholder={tf("router_login_placeholder", defaultRouterUser(info))}
                        onChange={(event) => setUser(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    </label>
                    <label className="router-field">
                      <span>{t("router_password")}</span>
                      <span className="router-password">
                        <input
                          type={passwordVisible ? "text" : "password"}
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder={t("router_password_placeholder")}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="router-password__toggle"
                          aria-label={passwordVisible ? t("router_password_hide") : t("router_password_show")}
                          title={passwordVisible ? t("router_password_hide") : t("router_password_show")}
                          aria-pressed={passwordVisible}
                          disabled={busy}
                          onClick={(event) => {
                            // A label around the field would move focus away; keep it in the field.
                            event.preventDefault();
                            setPasswordVisible((visible) => !visible);
                          }}
                        >
                          {passwordVisible ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                              <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          )}
                        </button>
                      </span>
                    </label>
                    <p className="router-panel__hint">{t("router_password_hint")}</p>
                    <label className="router-check">
                      <input type="checkbox" checked={autostart} disabled={busy} onChange={(event) => setAutostart(event.target.checked)} />
                      <span>{t("router_autostart")}</span>
                    </label>
                    <p className="router-panel__hint">{t("router_install_scope")}</p>
                    <div className="router-actions">
                      <button type="submit" className="router-button router-button--primary" disabled={busy || !password || !selectedServer}>
                        {t("router_install")}
                      </button>
                      {busy && <Spinner size={18} />}
                      {busy && step && INSTALL_STEPS[step] && (
                        <span className="router-panel__hint">{t(INSTALL_STEPS[step])}</span>
                      )}
                    </div>
                    {logLines.length > 0 && (
                      <InstallLog lines={logLines} open={logOpen} onToggle={() => setLogOpen((value) => !value)} />
                    )}
                  </form>
                ) : (
                  <button
                    type="button"
                    className="router-button router-button--primary"
                    disabled={!info.supported || !accountSubscriptionUrl() || servers.length === 0}
                    onClick={() => setFormOpen(true)}
                  >
                    {t("router_install")}
                  </button>
                )}
                {!info.supported && <p className="router-panel__hint">{t("router_install_unsupported")}</p>}
              </div>
            </>
          )}
        </ScrollEdgeAffordance>
      )}
    </div>
  );
}

/** Placeholders while the screen refreshes, as on the Devices screen. */
function RouterSkeleton({ installed }: { installed: boolean }) {
  const panel = (rows: number) => (
    <div className="router-panel router-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="router-skeleton__row">
          <span className="devices-skeleton__line" />
          <span className="devices-skeleton__line router-skeleton__value" />
        </div>
      ))}
    </div>
  );
  return (
    <>
      <div className="devices-card devices-skeleton__card" aria-hidden="true">
        <span className="devices-skeleton__icon" />
        <span className="devices-skeleton__info">
          <span className="devices-skeleton__line" />
          <span className="devices-skeleton__line devices-skeleton__line--wide" />
        </span>
        <span className="devices-skeleton__action" />
      </div>
      {installed ? (
        <>
          <div className="devices-section-title">{t("router_home_network_section")}</div>
          {panel(3)}
          <div className="devices-section-title">{t("router_controls_section")}</div>
          {panel(1)}
        </>
      ) : (
        <>
          <div className="devices-section-title">{t("router_vpn_section")}</div>
          {panel(2)}
        </>
      )}
    </>
  );
}

function toRouterSlot(server: SlotServer) {
  return { slot: server.slot, serverId: server.id, serverName: server.name };
}

/** Value of a device's select: "direct", or "server:<id>" for its server. */
function deviceChoice(device: RouterDevice, network: RouterNetwork): string {
  if (device.mode !== "vpn") return "direct";
  const slot =
    network.slots.find((item) => item.slot === device.slot) ?? network.slots.find((item) => item.slot === 0);
  return slot ? `server:${slot.serverId}` : "direct";
}

/**
 * Devices of the home network, each without VPN or through a server chosen
 * for it. Devices keep their choice by MAC, so a new address after
 * reconnecting does not change it; new devices start without VPN.
 */
function HomeNetwork({
  link,
  status,
  servers,
  pings,
  network,
  disabled,
  onBusy,
  onNetwork,
  onStatus,
  onError,
}: {
  link: RouterLink;
  status: RouterStatus;
  servers: VpnServer[];
  pings: Map<string, number>;
  network: RouterNetwork | null;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onNetwork: (network: RouterNetwork) => void;
  onStatus: (status: RouterStatus) => void;
  onError: (message: string | null) => void;
}) {
  const [savingMac, setSavingMac] = useState<string | null>(null);
  const [pickingMac, setPickingMac] = useState<string | null>(null);
  const [lanNames, setLanNames] = useState<Record<string, string>>(cachedLanNames);
  const migratingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    routerDevices(link)
      .then((next) => {
        if (!alive) return;
        onNetwork(next);
        if (status.clientIp) {
          void discoverLanNames(status.clientIp, next.devices).then((names) => {
            if (alive) setLanNames(names);
          });
        }
      })
      .catch((error) => {
        if (!alive) return;
        onError(routerErrorText(error));
        onNetwork({ devices: [], slots: [] });
      });
    return () => {
      alive = false;
    };
  }, [link.host]);

  // Earlier versions sent every device without a choice through the router's
  // server. Each such device now gets that server as its own choice, and new
  // devices start without VPN; nothing changes for the devices already there.
  useEffect(() => {
    if (!network || status.defaultMode !== "vpn" || migratingRef.current) return;
    migratingRef.current = true;
    void (async () => {
      try {
        const kept = network.devices.filter((device) => device.mode === "default");
        for (const device of kept) {
          await setRouterDevice(link, { mac: device.mac, mode: "vpn", slot: 0, name: device.name ?? "" });
        }
        onStatus(await setRouterDefaultMode(link, "direct"));
        onNetwork({
          ...network,
          devices: network.devices.map((device) =>
            device.mode === "default" ? { ...device, mode: "vpn", slot: 0 } : device,
          ),
        });
      } catch (error) {
        onError(routerErrorText(error));
      }
    })();
  }, [network, status.defaultMode]);

  /** Mode and slot for a choice; a server not yet on the router gets a free slot. */
  const save = async (device: RouterDevice, choice: string) => {
    if (!network) return;
    setSavingMac(device.mac);
    onError(null);
    try {
      let mode: RouterDevice["mode"] = "direct";
      let slot = 0;
      let current = network;
      if (choice.startsWith("server:")) {
        const plan = planSlots(servers, network, device.mac, choice.slice(7), limit);
        if (plan === "full") throw new Error("slots-full");
        if (!plan) throw new Error("server-missing");
        if (plan.list) {
          onBusy(true);
          try {
            onStatus(await setRouterServers(link, plan.list));
          } finally {
            onBusy(false);
          }
          current = { ...network, slots: plan.list.map(toRouterSlot) };
        }
        mode = "vpn";
        slot = plan.slot;
      }
      await setRouterDevice(link, { mac: device.mac, mode, slot, name: device.name ?? "" });
      onNetwork({
        ...current,
        devices: current.devices.map((item) => (item.mac === device.mac ? { ...item, mode, slot } : item)),
      });
    } catch (error) {
      const message = String(error);
      onError(
        message.includes("slots-full")
          ? tf("router_slots_full", limit, Math.round((status.memoryAvailableKb ?? 0) / 1024))
          : routerErrorText(error),
      );
    } finally {
      setSavingMac(null);
    }
  };

  const devices = network?.devices ?? null;
  // Servers already on the router keep their tunnels; how many more fit
  // depends on the router's free memory.
  const limit = routerServerLimit(status, network?.slots.length ?? 1);
  const picking = devices?.find((device) => device.mac === pickingMac) ?? null;

  return (
    <div className="router-panel">
      <p className="router-panel__hint">{t("router_devices_hint")}</p>
      {devices === null || !network ? (
        <Spinner size={20} />
      ) : devices.length === 0 ? (
        <p className="router-panel__hint">{t("router_no_devices")}</p>
      ) : (
        <div className="router-devices">
          {devices.map((device) => {
            const isThis = !!device.ip && device.ip === status.clientIp;
            const busy = disabled || savingMac === device.mac;
            const choice = deviceChoice(device, network);
            const chosenId = choice.startsWith("server:") ? choice.slice(7) : null;
            const chosenSlot = chosenId ? network.slots.find((item) => item.serverId === chosenId) : null;
            const serverDown = device.mode === "vpn" && status.downSlots.includes(chosenSlot?.slot ?? device.slot);
            return (
              <div
                key={device.mac}
                className={`router-device ${device.online ? "" : "router-device--offline"} ${isThis ? "router-device--this" : ""}`}
                title={isThis ? t("router_this_computer") : undefined}
              >
                <div className="router-device__info">
                  <div className="router-device__name router-device__name--static">
                    <span className="router-device__label">{routerDeviceLabel(device, lanNames)}</span>
                    {isThis && <span className="visually-hidden">{` · ${t("router_this_computer")}`}</span>}
                  </div>
                  <span className={`router-device__meta ${serverDown ? "router-device__meta--warn" : ""}`}>
                    {[
                      device.ip,
                      device.online ? null : t("router_device_offline"),
                      serverDown ? t("router_device_server_down") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <ServerChip
                  server={servers.find((server) => server.id === chosenId) ?? null}
                  serverName={chosenSlot?.serverName ?? null}
                  disabled={busy}
                  onClick={() => setPickingMac(device.mac)}
                />
              </div>
            );
          })}
        </div>
      )}
      {picking && network && (
        <ServerSheet
          deviceName={routerDeviceLabel(picking, lanNames)}
          servers={servers}
          pings={pings}
          onRouter={new Set(network.slots.map((item) => item.serverId))}
          canAdd={canAddServer(servers, network, picking.mac, limit)}
          limit={limit}
          selected={deviceChoice(picking, network).replace(/^server:/, "")}
          onClose={() => setPickingMac(null)}
          onSelect={(choice) => {
            const device = picking;
            if (choice !== deviceChoice(device, network).replace(/^server:/, "")) {
              void save(device, choice === "direct" ? "direct" : `server:${choice}`);
            }
          }}
        />
      )}
    </div>
  );
}

function pingColor(ping: number): string {
  if (ping < 100) return "var(--success)";
  if (ping < 200) return "var(--warning)";
  return "var(--danger)";
}

function formatTrafficBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${formatDecimal(bytes / 1024 ** 3, 1)} ${t("unit_gb")}`;
  if (bytes >= 1024 ** 2 || bytes === 0) return `${Math.round(bytes / 1024 ** 2)} ${t("unit_mb")}`;
  return `${formatDecimal(bytes / 1024 ** 2, 1)} ${t("unit_mb")}`;
}

/** VPN traffic of the home network through the router: today, month, by hour. */
function RouterTraffic() {
  const traffic = useRouterTraffic(60_000);
  const day = periodRanges("day");
  const month = periodRanges("month");
  const hours = day.map(([start, end]) => routerTrafficBetween(traffic.hours, start, end));
  const today = hours.reduce((sum, bytes) => sum + bytes, 0);
  const monthTotal = routerTrafficBetween(traffic.hours, month[0][0], month[month.length - 1][1]);
  const peak = Math.max(...hours, 1);
  const currentHour = new Date().getHours();
  const [hovered, setHovered] = useState<number | null>(null);
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  return (
    <div className="router-panel router-traffic">
      <div className="router-traffic__totals">
        <div className="router-traffic__total">
          <span className="router-traffic__value">
            {traffic.loading ? <TrafficSpinner /> : formatTrafficBytes(today)}
          </span>
          <span className="router-traffic__label">{t("router_traffic_today")}</span>
        </div>
        <div className="router-traffic__total router-traffic__total--secondary">
          <span className="router-traffic__value">
            {traffic.loading ? <TrafficSpinner /> : formatTrafficBytes(monthTotal)}
          </span>
          <span className="router-traffic__label">{t("router_traffic_month")}</span>
        </div>
      </div>
      <div className="router-traffic__chart" onMouseLeave={() => setHovered(null)}>
        {hours.map((bytes, index) => (
          <span
            key={index}
            className={`router-traffic__slot ${hovered === index ? "router-traffic__slot--hovered" : ""}`}
            onMouseEnter={() => setHovered(index)}
            aria-label={`${hourLabel(index)}–${hourLabel(index + 1)}: ${formatTrafficBytes(bytes)}`}
          >
            <span
              className={`router-traffic__bar ${index > currentHour ? "router-traffic__bar--future" : ""}`}
              style={{ height: bytes > 0 ? `${Math.max((bytes / peak) * 100, 6)}%` : "2px" }}
            />
          </span>
        ))}
        {hovered !== null && hovered <= currentHour && (
          <span
            className="router-traffic__tip"
            style={{
              left: `${((hovered + 0.5) / hours.length) * 100}%`,
              // Kept inside the panel at both ends of the day.
              transform: `translateX(${hovered < 3 ? "-15%" : hovered > hours.length - 4 ? "-85%" : "-50%"})`,
            }}
            role="tooltip"
          >
            <span className="router-traffic__tip-value">{formatTrafficBytes(hours[hovered])}</span>
            <span className="router-traffic__tip-time">{`${hourLabel(hovered)}–${hourLabel(hovered + 1)}`}</span>
          </span>
        )}
      </div>
      <div className="router-traffic__axis" aria-hidden="true">
        <span>0:00</span>
        <span>6:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}

/** The spinner of a server's ping being measured, while traffic is read. */
function TrafficSpinner() {
  return <span className="router-traffic__spinner" role="status" aria-label={t("router_traffic_loading")} />;
}

/** The device's server as a button: flag and name, or "No VPN". */
function ServerChip({
  server,
  serverName,
  disabled,
  onClick,
}: {
  server: VpnServer | null;
  serverName: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const name = server?.name ?? serverName;
  return (
    <button type="button" className={`router-chip ${name ? "" : "router-chip--off"}`} disabled={disabled} onClick={onClick}>
      {name ? (
        <>
          <span className="router-chip__flag">{countryFlagForUi(server?.country, name)}</span>
          <span className="router-chip__name">{serverDisplayName(name, server?.country)}</span>
        </>
      ) : (
        <span className="router-chip__name">{t("router_no_vpn")}</span>
      )}
      <svg className="router-chip__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

/**
 * The bottom sheet of the subscription plans: blurred backdrop, slide in and
 * out, handle, drag down to close. `children` gets `close`, which slides the
 * sheet away and then runs `after`. While `locked`, it cannot be closed.
 */
function BottomSheet({
  label,
  heading,
  locked = false,
  onClose,
  className = "",
  children,
}: {
  label: string;
  heading: ReactNode;
  locked?: boolean;
  onClose: () => void;
  className?: string;
  children: (close: (after?: () => void) => void) => ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; offset: number; activated: boolean } | null>(null);
  const snapTimerRef = useRef<number | null>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const { closing, requestClose } = useAnimatedDialogClose(onClose, SHEET_CLOSE_MS);

  const close = (after?: () => void) => {
    if (snapTimerRef.current !== null) window.clearTimeout(snapTimerRef.current);
    dragRef.current = null;
    requestClose(after ? () => {
      onClose();
      after();
    } : undefined);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !lockedRef.current) close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (snapTimerRef.current !== null) window.clearTimeout(snapTimerRef.current);
    };
  }, []);

  const resetDrag = () => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.classList.remove("sub-sheet--dragging", "sub-sheet--snapping");
    sheet.style.removeProperty("transform");
    sheet.style.removeProperty("--sub-sheet-close-from");
    sheet.style.removeProperty("--sub-sheet-snap-duration");
  };
  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || closing || locked || !sheetRef.current) return;
    if (snapTimerRef.current !== null) window.clearTimeout(snapTimerRef.current);
    resetDrag();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, offset: 0, activated: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    if (!drag || !sheet || drag.pointerId !== event.pointerId) return;
    const offset = Math.min(sheet.offsetHeight, Math.max(0, event.clientY - drag.startY));
    if (!drag.activated) {
      if (offset < SHEET_DRAG_ACTIVATION_PX) return;
      drag.activated = true;
      sheet.classList.add("sub-sheet--settled", "sub-sheet--dragging");
    }
    drag.offset = offset;
    sheet.style.transform = `translateY(${offset}px)`;
    event.preventDefault();
  };
  const finishDrag = (event: React.PointerEvent<HTMLElement>, allowClose: boolean) => {
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    if (!drag || !sheet || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.activated) {
      resetDrag();
      return;
    }
    sheet.classList.remove("sub-sheet--dragging");
    if (allowClose && drag.offset >= Math.min(150, Math.max(76, sheet.offsetHeight * 0.18))) {
      sheet.style.setProperty("--sub-sheet-close-from", `${drag.offset}px`);
      sheet.style.removeProperty("transform");
      close();
      return;
    }
    sheet.classList.add("sub-sheet--snapping");
    const duration = Math.round(Math.min(310, Math.max(210, 175 + drag.offset * 0.72)));
    sheet.style.setProperty("--sub-sheet-snap-duration", `${duration}ms`);
    void sheet.offsetHeight;
    sheet.style.transform = "translateY(0px)";
    snapTimerRef.current = window.setTimeout(() => {
      snapTimerRef.current = null;
      if (!dragRef.current) resetDrag();
    }, duration + 32);
  };
  const dragHandlers = {
    onPointerDown: startDrag,
    onPointerMove: moveDrag,
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => finishDrag(event, true),
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => finishDrag(event, false),
  };

  return (
    <div
      className={`sub-sheet-overlay ${closing ? "sub-sheet-overlay--closing" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget && !locked) close();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`sub-sheet router-sheet ${className} ${closing ? "sub-sheet--closing" : ""}`}
      >
        <div className="sub-sheet__handle" aria-hidden="true" {...dragHandlers} />
        {!locked && (
          <button type="button" className="sub-sheet__close" onClick={() => close()} aria-label={t("close")} title={t("close")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <div className="router-sheet__heading" {...dragHandlers}>
          {heading}
        </div>
        {children(close)}
      </div>
    </div>
  );
}

const CHECK_ICON = (
  <svg className="router-sheet__check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/** Choice of a server for one device. */
function ServerSheet({
  deviceName,
  servers,
  pings,
  onRouter,
  canAdd,
  limit,
  selected,
  onSelect,
  onClose,
}: {
  deviceName: string;
  servers: VpnServer[];
  pings: Map<string, number>;
  /** Servers already on the router: choosing one does not restart the tunnels. */
  onRouter: Set<string>;
  /** False when the router holds as many servers as its memory allows. */
  canAdd: boolean;
  limit: number;
  /** "direct" or a server id. */
  selected: string;
  onSelect: (choice: string) => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet
      label={`${t("router_pick_server_title")}: ${deviceName}`}
      onClose={onClose}
      heading={
        <>
          <span className="router-sheet__title">{t("router_pick_server_title")}</span>
          <span className="router-sheet__device">{deviceName}</span>
        </>
      }
    >
      {(close) => {
        const pick = (choice: string) => close(() => onSelect(choice));
        return (
          <>
            {!canAdd && <p className="router-sheet__notice">{tf("router_sheet_full", limit)}</p>}
            <ScrollEdgeAffordance className="router-sheet__list" overlayFade>
              <button
                type="button"
                className={`router-sheet__row ${selected === "direct" ? "router-sheet__row--selected" : ""}`}
                onClick={() => pick("direct")}
              >
                <span className="router-sheet__flag router-sheet__flag--off">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
                  </svg>
                </span>
                <span className="router-sheet__text">
                  <span className="router-sheet__name">{t("router_no_vpn")}</span>
                  <span className="router-sheet__sub">{t("router_no_vpn_hint")}</span>
                </span>
                {selected === "direct" && CHECK_ICON}
              </button>
              {servers.map((server) => {
                const ping = pings.get(server.id);
                const blocked = !canAdd && !onRouter.has(server.id) && selected !== server.id;
                return (
                  <button
                    key={server.id}
                    type="button"
                    className={`router-sheet__row ${selected === server.id ? "router-sheet__row--selected" : ""}`}
                    disabled={blocked}
                    onClick={() => pick(server.id)}
                  >
                    <span className="router-sheet__flag">{countryFlagForUi(server.country, server.name)}</span>
                    <span className="router-sheet__text">
                      <span className="router-sheet__name">{serverDisplayName(server.name, server.country)}</span>
                      {onRouter.has(server.id) && <span className="router-sheet__sub">{t("router_server_on_router")}</span>}
                      {blocked && <span className="router-sheet__sub">{t("router_server_no_room")}</span>}
                    </span>
                    {ping !== undefined && (
                      <span className="router-sheet__ping" style={{ color: ping >= 0 ? pingColor(ping) : "var(--text-muted)" }}>
                        {ping >= 0 ? tf("router_ping_ms", ping) : t("router_ping_none")}
                      </span>
                    )}
                    {selected === server.id && CHECK_ICON}
                  </button>
                );
              })}
            </ScrollEdgeAffordance>
          </>
        );
      }}
    </BottomSheet>
  );
}

/**
 * A centred window over the screen, as the app's other dialogs (What's new,
 * demo login): blurred backdrop, rise in, fade out. While `locked` it cannot
 * be closed.
 */
function CenterDialog({
  label,
  locked = false,
  onClose,
  children,
}: {
  label: string;
  locked?: boolean;
  onClose: () => void;
  children: (close: (after?: () => void) => void) => ReactNode;
}) {
  const { closing, requestClose } = useAnimatedDialogClose(onClose);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const close = (after?: () => void) =>
    requestClose(after ? () => {
      onClose();
      after();
    } : undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !lockedRef.current) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return createPortal(
    <div
      className={`whats-new-overlay ${closing ? "whats-new-overlay--closing" : ""}`}
      onClick={() => {
        if (!locked) close();
      }}
    >
      <div
        className="whats-new-dialog router-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {children(close)}
      </div>
    </div>,
    document.getElementById("overlay-root") ?? document.body,
  );
}

type StepState = "pending" | "active" | "done" | "failed";

/**
 * Removing ToBeVPN: a question, then each step with its spinner, then the
 * result, all in one sheet. The router is also taken off the account, so it
 * no longer takes a device of the subscription.
 */
function UninstallSheet({
  link,
  hwid,
  onClose,
  onRemoved,
}: {
  link: RouterLink;
  hwid: string | null;
  onClose: () => void;
  /** After "Done": the screen goes back to the router without ToBeVPN. */
  onRemoved: () => void;
}) {
  const [phase, setPhase] = useState<"confirm" | "working" | "done" | "failed">("confirm");
  const [steps, setSteps] = useState<StepState[]>(["pending", "pending"]);
  const [error, setError] = useState<string | null>(null);
  const removedRef = useRef(false);

  const setStep = (index: number, state: StepState) =>
    setSteps((current) => current.map((value, position) => (position === index ? state : value)));

  const run = async () => {
    setPhase("working");
    setError(null);
    try {
      if (!removedRef.current) {
        setStep(0, "active");
        await routerControl(link, "uninstall");
        removedRef.current = true;
        setStep(0, "done");
      }
      setStep(1, "active");
      await unlinkRouterFromAccount(hwid);
      setStep(1, "done");
      setPhase("done");
    } catch (failure) {
      setSteps((current) => current.map((value) => (value === "active" ? "failed" : value)));
      // The router step fails with the router's errors; the account step
      // with the account's.
      setError(
        removedRef.current
          ? tf("router_uninstall_account_failed", String(failure ?? "").replace(/^\w*Error:\s*/, "").slice(0, 200))
          : routerErrorText(failure),
      );
      setPhase("failed");
    }
  };

  const finish = (close: (after?: () => void) => void) =>
    close(() => {
      if (removedRef.current) onRemoved();
    });

  const labels = [t("router_uninstall_step_router"), t("router_uninstall_step_account")];

  return (
    <CenterDialog
      label={t("router_uninstall")}
      locked={phase === "working"}
      onClose={() => {
        onClose();
        if (removedRef.current) onRemoved();
      }}
    >
      {(close) => (
        <div className="router-uninstall-sheet">
          <h2 className="whats-new-dialog__title">
            {phase === "done" ? t("router_uninstall_done_title") : t("router_uninstall")}
          </h2>
          {phase === "confirm" ? (
            <p className="router-uninstall-sheet__text">{t("router_uninstall_explain")}</p>
          ) : phase === "done" ? (
            <div className="router-uninstall-sheet__done">
              <span className="router-uninstall-sheet__done-icon">{CHECK_ICON}</span>
              <p className="router-uninstall-sheet__text">{t("router_uninstall_done_text")}</p>
            </div>
          ) : (
            <ul className="router-uninstall-sheet__steps">
              {labels.map((label, index) => (
                <li key={label} className={`router-uninstall-sheet__step router-uninstall-sheet__step--${steps[index]}`}>
                  <span className="router-uninstall-sheet__mark" aria-hidden="true">
                    {steps[index] === "active" ? (
                      <span className="router-traffic__spinner" />
                    ) : steps[index] === "done" ? (
                      CHECK_ICON
                    ) : steps[index] === "failed" ? (
                      "!"
                    ) : null}
                  </span>
                  {label}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="router-uninstall-sheet__error">{error}</p>}
          <div className="router-bottom__buttons">
            {phase === "confirm" && (
              <>
                <button type="button" className="router-button" onClick={() => close()}>
                  {t("cancel")}
                </button>
                <button type="button" className="router-button router-button--danger-solid" onClick={() => void run()}>
                  {t("router_uninstall_yes")}
                </button>
              </>
            )}
            {phase === "failed" && (
              <>
                <button type="button" className="router-button" onClick={() => finish(close)}>
                  {t("close")}
                </button>
                <button type="button" className="router-button router-button--danger-solid" onClick={() => void run()}>
                  {t("router_retry")}
                </button>
              </>
            )}
            {phase === "done" && (
              <button type="button" className="router-button router-button--primary" onClick={() => finish(close)}>
                {t("router_done")}
              </button>
            )}
          </div>
        </div>
      )}
    </CenterDialog>
  );
}
