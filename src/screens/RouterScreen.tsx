import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { t, tf, type StringKey } from "../i18n";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import Spinner from "../components/Spinner";
import { getCachedVpnServers, isAvailableVpnServer, type VpnServer } from "../session/auth";
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
  routerDeviceLabel,
  ROUTER_EXTRA_SLOTS,
  routerDevices,
  setRouterDefaultMode,
  setRouterDevice,
  type RouterAction,
  type RouterDevice,
  type RouterDeviceMode,
  type RouterInfo,
  type RouterLink,
  type RouterNetwork,
  type RouterStatus,
  type SlotServer,
} from "../session/router";
import "./DevicesScreen.css";
import "./RouterScreen.css";

const MIN_REFRESH_FEEDBACK_MS = 800;

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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ${t("unit_gb")}`;
  return `${Math.round(bytes / 1024 ** 2)} ${t("unit_mb")}`;
}

function routableServers(): VpnServer[] {
  return getCachedVpnServers().filter(isAvailableVpnServer);
}

function slotServer(slot: number, server: VpnServer): SlotServer {
  return { slot, id: server.id, name: server.name, server: serverProfileConfig(server) };
}

/** Extra slots some device still uses, by slot number. */
function usedExtraSlots(network: RouterNetwork, exceptMac?: string): Set<number> {
  return new Set(
    network.devices
      .filter((device) => device.mac !== exceptMac && device.mode === "vpn" && device.slot > 0)
      .map((device) => device.slot),
  );
}

/**
 * Server list for the router: the router's server in slot 0 and the extra
 * slots still in use. A slot whose server left the account is dropped; its
 * devices then use the router's server.
 */
function slotServers(
  servers: VpnServer[],
  mainId: string,
  network: RouterNetwork,
  exceptMac?: string,
): SlotServer[] | null {
  const main = servers.find((server) => server.id === mainId);
  if (!main) return null;
  const used = usedExtraSlots(network, exceptMac);
  const result = [slotServer(0, main)];
  for (const slot of network.slots) {
    if (slot.slot === 0 || !used.has(slot.slot)) continue;
    const server = servers.find((candidate) => candidate.id === slot.serverId);
    if (server) result.push(slotServer(slot.slot, server));
  }
  return result;
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
  const [autostart, setAutostart] = useState(true);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const servers = useMemo(routableServers, []);
  const [serverId, setServerId] = useState<string>(() => link?.serverId ?? servers[0]?.id ?? "");
  const [network, setNetwork] = useState<RouterNetwork | null>(null);
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
    setInfo(nextInfo);
    setLink(currentLink);
    setStatus(nextStatus);
    setUser((value) => value || defaultRouterUser(nextInfo));
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    void load(false);
    const unlisten = listen<string>("router-install-progress", (event) => setStep(event.payload));
    return () => {
      generationRef.current += 1;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const selectedServer = servers.find((server) => server.id === serverId) ?? null;

  const handleInstall = async () => {
    const subscriptionUrl = accountSubscriptionUrl();
    if (!info?.gateway || !selectedServer || !subscriptionUrl || !password) return;
    setBusy(true);
    setError(null);
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

  const changeServer = async (id: string) => {
    setServerId(id);
    const list = network && slotServers(servers, id, network);
    if (!link || !list) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await setRouterServers(link, list));
      setNetwork((current) => current && { ...current, slots: list.map(toRouterSlot) });
      setLink(getRouterLink());
    } catch (serverError) {
      setError(routerErrorText(serverError));
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
      ) : (
        <div className="router-content">
          <div className="devices-card devices-card--current">
            <div className="devices-card__icon"><RouterIcon /></div>
            <div className="devices-card__info">
              <div className="devices-card__name">{detected ? info.model : t("router_not_detected")}</div>
              {routerMeta(info) && <div className="devices-card__meta">{routerMeta(info)}</div>}
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
          {error && <p className="router-error">{error}</p>}

          {installed && status ? (
            <>
              <div className="devices-section-title">{t("router_vpn_section")}</div>
              <div className="router-panel">
                <label className="router-row">
                  <span>{t("router_server")}</span>
                  <select
                    className="router-select"
                    value={link?.serverId ?? serverId}
                    disabled={busy}
                    onChange={(event) => void changeServer(event.target.value)}
                  >
                    {!servers.some((server) => server.id === link?.serverId) && link?.serverName && (
                      <option value={link.serverId ?? ""}>{link.serverName}</option>
                    )}
                    {servers.map((server) => (
                      <option key={server.id} value={server.id}>{server.name}</option>
                    ))}
                  </select>
                </label>
                <div className="router-row">
                  <span>{t("router_tunnel_traffic")}</span>
                  <span className="router-row__value">
                    {formatBytes(status.tunnelRxBytes + status.tunnelTxBytes)}
                  </span>
                </div>
                {status.xrayMemoryKb !== null && status.memoryAvailableKb !== null && (
                  <div className="router-row">
                    <span>{t("router_memory")}</span>
                    <span className="router-row__value">
                      {tf(
                        "router_memory_value",
                        Math.round(status.xrayMemoryKb / 1024),
                        Math.round(status.memoryAvailableKb / 1024),
                      )}
                    </span>
                  </div>
                )}
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
                <div className="router-actions">
                  <button
                    type="button"
                    className="router-panel__action"
                    disabled={busy}
                    onClick={() => void runAction(status.running ? "stop" : "start")}
                  >
                    {status.running ? t("router_stop") : t("router_start")}
                  </button>
                  {busy && <Spinner size={18} />}
                </div>
              </div>

              <div className="devices-section-title">{t("router_home_network_section")}</div>
              {link && (
                <HomeNetwork
                  link={link}
                  status={status}
                  servers={servers}
                  network={network}
                  disabled={busy}
                  onBusy={setBusy}
                  onNetwork={setNetwork}
                  onStatus={setStatus}
                  onError={setError}
                />
              )}

              <div className="router-uninstall">
                {confirmUninstall ? (
                  <>
                    <span>{t("router_uninstall_confirm")}</span>
                    <button type="button" className="router-link router-link--danger" disabled={busy} onClick={() => void runAction("uninstall")}>
                      {t("router_uninstall_yes")}
                    </button>
                    <button type="button" className="router-link" disabled={busy} onClick={() => setConfirmUninstall(false)}>
                      {t("cancel")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="router-link router-link--danger" disabled={busy} onClick={() => setConfirmUninstall(true)}>
                    {t("router_uninstall")}
                  </button>
                )}
              </div>
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
                      <input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="off" disabled={busy} />
                    </label>
                    <label className="router-field">
                      <span>{t("router_password")}</span>
                      <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" disabled={busy} />
                    </label>
                    <p className="router-panel__hint">{t("router_password_hint")}</p>
                    <label className="router-field">
                      <span>{t("router_server")}</span>
                      <select className="router-select" value={serverId} disabled={busy} onChange={(event) => setServerId(event.target.value)}>
                        {servers.map((server) => (
                          <option key={server.id} value={server.id}>{server.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="router-check">
                      <input type="checkbox" checked={autostart} disabled={busy} onChange={(event) => setAutostart(event.target.checked)} />
                      <span>{t("router_autostart")}</span>
                    </label>
                    <p className="router-panel__hint">{t("router_install_scope")}</p>
                    <div className="router-actions">
                      <button type="submit" className="router-panel__action" disabled={busy || !password || !selectedServer}>
                        {t("router_install")}
                      </button>
                      {busy && <Spinner size={18} />}
                      {busy && step && INSTALL_STEPS[step] && (
                        <span className="router-panel__hint">{t(INSTALL_STEPS[step])}</span>
                      )}
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="router-panel__action"
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
        </div>
      )}
    </div>
  );
}

/**
 * Devices of the home network, each through the router's VPN or direct.
 * Devices keep their choice by MAC, so a new address after reconnecting
 * does not change it.
 */
function toRouterSlot(server: SlotServer) {
  return { slot: server.slot, serverId: server.id, serverName: server.name };
}

/** Value of a device's select: a mode, or "server:<id>" for its own server. */
function deviceChoice(device: RouterDevice, network: RouterNetwork): string {
  if (device.mode !== "vpn" || device.slot === 0) return device.mode;
  const slot = network.slots.find((item) => item.slot === device.slot);
  return slot ? `server:${slot.serverId}` : "vpn";
}

function HomeNetwork({
  link,
  status,
  servers,
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
  network: RouterNetwork | null;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onNetwork: (network: RouterNetwork) => void;
  onStatus: (status: RouterStatus) => void;
  onError: (message: string | null) => void;
}) {
  const [savingMac, setSavingMac] = useState<string | null>(null);
  const [editingMac, setEditingMac] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  useEffect(() => {
    let alive = true;
    routerDevices(link)
      .then((next) => {
        if (alive) onNetwork(next);
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

  const mainSlot = network?.slots.find((slot) => slot.slot === 0);
  const mainId = mainSlot?.serverId ?? link.serverId ?? "";
  const mainName = mainSlot?.serverName ?? link.serverName ?? "";

  const updateDevice = (current: RouterNetwork, device: RouterDevice, patch: Partial<RouterDevice>) => ({
    ...current,
    devices: current.devices.map((item) => (item.mac === device.mac ? { ...item, ...patch } : item)),
  });

  /** Mode and slot for a choice; a server not yet in a slot gets a free one. */
  const save = async (device: RouterDevice, choice: string, name: string | null) => {
    if (!network) return;
    setSavingMac(device.mac);
    onError(null);
    try {
      let mode: RouterDevice["mode"] = "vpn";
      let slot = 0;
      let current = network;
      if (choice === "default" || choice === "direct") {
        mode = choice;
      } else if (choice.startsWith("server:") && choice.slice(7) !== mainId) {
        const serverId = choice.slice(7);
        const used = usedExtraSlots(network, device.mac);
        const existing = network.slots.find(
          (item) => item.slot > 0 && item.serverId === serverId && used.has(item.slot),
        );
        if (existing) {
          slot = existing.slot;
        } else {
          const free = [1, 2, 3].slice(0, ROUTER_EXTRA_SLOTS).find((candidate) => !used.has(candidate));
          const server = servers.find((candidate) => candidate.id === serverId);
          if (free === undefined) throw new Error("slots-full");
          const list = server && slotServers(servers, mainId, network, device.mac);
          if (!list || !server) throw new Error("server-missing");
          list.push(slotServer(free, server));
          onBusy(true);
          try {
            onStatus(await setRouterServers(link, list));
          } finally {
            onBusy(false);
          }
          current = { ...network, slots: list.map(toRouterSlot) };
          slot = free;
        }
      }
      await setRouterDevice(link, { mac: device.mac, mode, slot, name: name ?? "" });
      onNetwork(updateDevice(current, device, { mode, slot, name }));
    } catch (error) {
      const message = String(error);
      onError(message.includes("slots-full") ? tf("router_slots_full", ROUTER_EXTRA_SLOTS) : routerErrorText(error));
    } finally {
      setSavingMac(null);
      setEditingMac(null);
    }
  };

  const changeDefault = async (mode: RouterDeviceMode) => {
    onError(null);
    try {
      onStatus(await setRouterDefaultMode(link, mode));
    } catch (error) {
      onError(routerErrorText(error));
    }
  };

  const modeLabel = (mode: RouterDeviceMode) =>
    mode === "vpn" ? t("router_mode_vpn") : t("router_mode_direct");
  const devices = network?.devices ?? null;

  return (
    <div className="router-panel">
      <label className="router-row">
        <span>{t("router_default_mode")}</span>
        <select
          className="router-select"
          value={status.defaultMode}
          disabled={disabled}
          onChange={(event) => void changeDefault(event.target.value as RouterDeviceMode)}
        >
          <option value="vpn">{t("router_mode_vpn")}</option>
          <option value="direct">{t("router_mode_direct")}</option>
        </select>
      </label>
      <p className="router-panel__hint">{tf("router_home_network_description_slots", ROUTER_EXTRA_SLOTS)}</p>
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
            const ownServer = choice.startsWith("server:")
              ? network.slots.find((item) => item.slot === device.slot)
              : null;
            return (
              <div key={device.mac} className={`router-device ${device.online ? "" : "router-device--offline"}`}>
                <div className="router-device__info">
                  {editingMac === device.mac ? (
                    <form
                      className="router-device__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void save(device, choice, nameDraft.trim() || null);
                      }}
                    >
                      <input
                        value={nameDraft}
                        maxLength={40}
                        autoFocus
                        disabled={busy}
                        onChange={(event) => setNameDraft(event.target.value)}
                        placeholder={device.hostname ?? ""}
                      />
                      <button type="submit" className="router-link" disabled={busy}>{t("router_rename_save")}</button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="router-device__name"
                      disabled={busy}
                      title={t("router_rename")}
                      onClick={() => {
                        setEditingMac(device.mac);
                        setNameDraft(device.name ?? "");
                      }}
                    >
                      {routerDeviceLabel(device)}
                      {isThis && <span className="router-device__tag">{t("router_this_computer")}</span>}
                    </button>
                  )}
                  <span className="router-device__meta">
                    {[device.ip, device.online ? null : t("router_device_offline")].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <select
                  className="router-select router-select--compact"
                  value={choice}
                  disabled={busy}
                  onChange={(event) => void save(device, event.target.value, device.name)}
                >
                  <option value="default">{tf("router_mode_default", modeLabel(status.defaultMode))}</option>
                  <option value="vpn">{mainName ? tf("router_mode_vpn_server", mainName) : t("router_mode_vpn")}</option>
                  <option value="direct">{t("router_mode_direct")}</option>
                  <optgroup label={t("router_own_server")}>
                    {ownServer && !servers.some((server) => server.id === ownServer.serverId) && (
                      <option value={choice}>{ownServer.serverName}</option>
                    )}
                    {servers
                      .filter((server) => server.id !== mainId)
                      .map((server) => (
                        <option key={server.id} value={`server:${server.id}`}>{server.name}</option>
                      ))}
                  </optgroup>
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
