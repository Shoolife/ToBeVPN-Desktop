import { useEffect, useRef, useState } from "react";
import { t, tf } from "../i18n";
import { fetchDevices, getCurrentDeviceAliases, unlinkOtherDevice } from "../session/auth";
import { getSession } from "../session/store";
import { formatEpochSecondsDateDots } from "../session/dateFormat";
import Spinner from "../components/Spinner";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import CenterDialog from "../components/CenterDialog";
import ResetLinkOption from "../components/ResetLinkOption";
import type { LinkedDeviceDto } from "../api/types";
import { usePersonalDataHidden } from "../session/profileDisplay";
import {
  detectRouter,
  getCachedRouter,
  isRouterDevice,
  getRouterLink,
  routerNameFor,
  sameRouterModel,
  ROUTER_CHANGED_EVENT,
  type RouterLink,
  ROUTER_SECTION_AVAILABLE,
  type RouterInfo,
} from "../session/router";
import { RouterIcon, routerMeta } from "./RouterScreen";
import "./DevicesScreen.css";

type DeviceKind = "phone" | "desktop" | "tv";
const MIN_REFRESH_FEEDBACK_MS = 800;

function inferDeviceKind(dto: LinkedDeviceDto): DeviceKind {
  const type = (dto.device_type ?? "").toLowerCase();
  const platform = (dto.platform ?? "").toLowerCase();
  const userAgent = (dto.user_agent ?? "").toLowerCase();
  const desktopPlatform = platform === "linux" || platform === "windows" || platform === "macos";
  if (type === "tv" || platform === "android tv" || userAgent.includes("/androidtv/")) return "tv";
  if (desktopPlatform || type === "desktop" || userAgent.includes("/linux/") || userAgent.includes("/windows/") || userAgent.includes("/macos/")) {
    return "desktop";
  }
  return "phone";
}

function deviceTypeLabel(dto: LinkedDeviceDto): string {
  const type = inferDeviceKind(dto);
  if (type === "tv") return t("devices_type_tv");
  if (type === "desktop") return t("devices_type_desktop");
  return t("devices_type_phone");
}

function deviceTypeIcon(dto: LinkedDeviceDto): React.ReactNode {
  const type = inferDeviceKind(dto);
  if (type === "tv") {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2" /><polyline points="17 2 12 7 7 2" />
      </svg>
    );
  }
  if (type === "desktop") {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}

function deviceMatchesAliases(dto: LinkedDeviceDto, aliases: string[]): boolean {
  const normalizedAliases = new Set(
    aliases.map((alias) => alias.trim().toLocaleLowerCase("en-US")).filter(Boolean),
  );
  return [dto.device_id, dto.hwid].some((value) => {
    const normalizedValue = value?.trim().toLocaleLowerCase("en-US");
    return !!normalizedValue && normalizedAliases.has(normalizedValue);
  });
}

function isTechnicalDesktopName(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,31}$/.test(value) && value === value.toLowerCase();
}

function cleanDesktopModel(model: string | null | undefined, platform: string | null | undefined): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase();
  const normalizedPlatform = platform?.trim().toLowerCase() ?? "";
  if (normalized === "desktop" || normalized === "pc" || normalized === normalizedPlatform) return "";
  return trimmed;
}

// With personal data hidden the user-given device name (often the owner's
// name) is skipped in favour of the model.
function deviceName(dto: LinkedDeviceDto, hideName = false): string {
  const kind = inferDeviceKind(dto);
  if (kind === "desktop") {
    const name = hideName ? "" : dto.device_name?.trim() ?? "";
    if (name && !isTechnicalDesktopName(name)) return name;
    const model = cleanDesktopModel(dto.device_model, dto.platform);
    if (model) return model;
    const platform = dto.platform?.trim();
    return platform ? `${t("devices_type_desktop")} ${platform}` : t("devices_type_desktop");
  }
  return (
    (hideName ? "" : dto.device_name?.trim()) ||
    dto.device_model?.trim() ||
    deviceTypeLabel(dto)
  );
}

function DeviceCardSkeleton({ action = false }: { action?: boolean }) {
  return (
    <div className="devices-card devices-skeleton__card" aria-hidden="true">
      <span className="devices-skeleton__icon" />
      <span className="devices-skeleton__info">
        <span className="devices-skeleton__line" />
        <span className="devices-skeleton__line devices-skeleton__line--wide" />
      </span>
      {action && <span className="devices-skeleton__action" />}
    </div>
  );
}

/** The last list, shown at once when the screen opens again; refreshed in the background. */
let cachedDevices: {
  account: string | null;
  devices: LinkedDeviceDto[];
  maxDevices: number;
  currentCount: number | null;
  aliases: string[];
} | null = null;

/** The cached list, only for the account it was loaded for. */
function devicesCacheNow() {
  return cachedDevices && cachedDevices.account === getSession().shortUuid ? cachedDevices : null;
}

export default function DevicesScreen({
  onBack,
  onOpenRouter,
}: {
  onBack: () => void;
  onOpenRouter: () => void;
}) {
  const [router, setRouter] = useState<RouterInfo | null>(() => getCachedRouter());
  const [routerLink, setRouterLink] = useState<RouterLink | null>(() => getRouterLink());
  const personalHidden = usePersonalDataHidden();
  const [devices, setDevices] = useState<LinkedDeviceDto[]>(() => devicesCacheNow()?.devices ?? []);
  const [maxDevices, setMaxDevices] = useState(() => devicesCacheNow()?.maxDevices ?? 0);
  const [currentCount, setCurrentCount] = useState<number | null>(() => devicesCacheNow()?.currentCount ?? null);
  const [currentAliases, setCurrentAliases] = useState<string[]>(() => devicesCacheNow()?.aliases ?? []);
  const [isInitialLoading, setInitialLoading] = useState(() => devicesCacheNow() === null);
  const [isRefreshing, setRefreshing] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; name: string } | null>(null);
  const loadGenerationRef = useRef(0);
  const unlinkGenerationRef = useRef(0);
  const unlinkingRef = useRef(false);
  const mountedRef = useRef(true);

  const load = async (refresh = false) => {
    const generation = ++loadGenerationRef.current;
    const refreshStartedAt = refresh ? performance.now() : null;
    setInitialLoading(!refresh && devicesCacheNow() === null);
    setRefreshing(refresh);
    setError(null);
    try {
      const [data, aliases] = await Promise.all([
        fetchDevices(),
        getCurrentDeviceAliases(),
      ]);
      // Match the promocodes screen: a fast response still completes a smooth,
      // readable refresh turn instead of stopping the icon mid-frame.
      if (refreshStartedAt !== null) {
        const remaining = MIN_REFRESH_FEEDBACK_MS - (performance.now() - refreshStartedAt);
        if (remaining > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remaining));
        }
      }
      if (generation !== loadGenerationRef.current) return;
      setCurrentAliases(aliases);
      if (data) {
        setDevices(data.devices);
        setMaxDevices(data.max_devices);
        setCurrentCount(data.current_count ?? null);
        cachedDevices = {
          account: getSession().shortUuid,
          devices: data.devices,
          maxDevices: data.max_devices,
          currentCount: data.current_count ?? null,
          aliases,
        };
      }
    } catch {
      if (generation === loadGenerationRef.current) {
        setError(t("devices_load_error"));
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    const update = () => setRouterLink(getRouterLink());
    window.addEventListener(ROUTER_CHANGED_EVENT, update);
    return () => window.removeEventListener(ROUTER_CHANGED_EVENT, update);
  }, []);

  useEffect(() => {
    if (!ROUTER_SECTION_AVAILABLE) return;
    let alive = true;
    void detectRouter().then((info) => {
      if (alive) setRouter(info);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      unlinkGenerationRef.current += 1;
      unlinkingRef.current = false;
    };
  }, []);

  const handleUnlink = async (deviceId: string, resetSubscription: boolean): Promise<boolean> => {
    if (unlinkingRef.current) return false;
    unlinkingRef.current = true;
    const generation = ++unlinkGenerationRef.current;
    setUnlinkingId(deviceId);
    setError(null);
    try {
      await unlinkOtherDevice(deviceId, resetSubscription);
      if (!mountedRef.current || generation !== unlinkGenerationRef.current) return true;
      setDevices((prev) => prev.filter((d) => d.device_id !== deviceId));
      if (cachedDevices) {
        cachedDevices = { ...cachedDevices, devices: cachedDevices.devices.filter((d) => d.device_id !== deviceId) };
      }
      setCurrentCount((count) =>
        count === null ? null : Math.max(0, count - 1),
      );
      return true;
    } catch {
      if (mountedRef.current && generation === unlinkGenerationRef.current) {
        setError(t("devices_unlink_error"));
      }
      return false;
    } finally {
      if (generation === unlinkGenerationRef.current) {
        unlinkingRef.current = false;
        if (mountedRef.current) setUnlinkingId(null);
      }
    }
  };

  const devicesCount = currentCount ?? devices.length;
  const currentDevice = devices.find((d) => deviceMatchesAliases(d, currentAliases));
  // Routers have their own section: the one of this network opens its
  // settings; other routers of the account (another home, a cottage) are
  // listed with the names given to them and can be disconnected.
  const otherDevices = devices.filter(
    (d) => !deviceMatchesAliases(d, currentAliases) && !isRouterDevice(d),
  );
  const linkedHere = !!routerLink && !!router?.gateway && routerLink.host === router.gateway;
  // The account's router that answers here: by its device id once linked,
  // else by its model (ToBeVPN set up on it from another device).
  const isRouterHere = (d: (typeof devices)[number]) =>
    linkedHere && routerLink?.hwid
      ? !!d.hwid && d.hwid.toLowerCase() === routerLink.hwid.toLowerCase()
      // Not linked, or linked before the router's id was read: by its model.
      : sameRouterModel(d.device_model ?? "", router?.model);
  const installedHere = !linkedHere && devices.some((d) => isRouterDevice(d) && isRouterHere(d));
  const otherRouters = ROUTER_SECTION_AVAILABLE
    ? devices.filter((d) => isRouterDevice(d) && !isRouterHere(d))
    : [];
  const showRouter = ROUTER_SECTION_AVAILABLE && (!!router?.gateway || otherRouters.length > 0);
  const hereName = (linkedHere && routerLink?.name) || router?.model || t("router_not_detected");

  return (
    <div className="devices-root">
      {/* Top bar */}
      <div className="devices-topbar">
        <button className="devices-topbar__back" onClick={onBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="devices-topbar__title">{t("devices_title")}</span>
        <TopbarRefreshButton
          label={t("refresh")}
          loading={isInitialLoading || isRefreshing}
          onClick={() => void load(true)}
          disabled={isInitialLoading || isRefreshing || unlinkingId !== null}
        />
      </div>

      {/* Counter, this device and the section title stay put; only the list
          of other devices scrolls. */}
      <div className="devices-fixed">
        {error && (
          <button type="button" className="devices-error" onClick={() => void load(true)}>
            {error}
          </button>
        )}
        {/* Counter */}
        <div className="devices-counter">
          <span className="devices-counter__count">
            {maxDevices === 0 ? devicesCount : `${devicesCount}/${maxDevices}`}
          </span>
          <span className="devices-counter__label">
            {maxDevices === 0 ? t("devices_count_unlimited") : t("devices_count")}
          </span>
        </div>

        {!isInitialLoading && (
          <>
            {/* Current device */}
            {isRefreshing ? (
              currentDevice !== undefined && (
                <>
                  <div className="devices-section-title">{t("devices_this_device")}</div>
                  <DeviceCardSkeleton action />
                </>
              )
            ) : currentDevice && (
              <>
                <div className="devices-section-title">{t("devices_this_device")}</div>
                <div className="devices-card devices-card--current">
                  <div className="devices-card__icon">{deviceTypeIcon(currentDevice)}</div>
                  <div className="devices-card__info">
                    <div className="devices-card__name">
                      {deviceName(currentDevice, personalHidden)}
                    </div>
                    <div className="devices-card__meta">
                      {deviceTypeLabel(currentDevice)}
                      {currentDevice.platform ? ` \u00B7 ${currentDevice.platform}` : ""}
                    </div>
                  </div>
                  <span className="devices-card__badge">{t("devices_current_badge")}</span>
                </div>
              </>
            )}

            {showRouter && (
              <>
                <div className="devices-section-title">
                  {otherRouters.length + (router?.gateway ? 1 : 0) > 1
                    ? t("router_section_title_many")
                    : t("router_section_title")}
                </div>
                {router?.gateway && (
                  <button type="button" className="devices-card devices-card--router" onClick={onOpenRouter}>
                    <div className="devices-card__icon"><RouterIcon /></div>
                    <div className="devices-card__info">
                      <div className="devices-card__name">{hereName}</div>
                      <div className="devices-card__meta">
                        {linkedHere && routerLink?.name && router.model ? `${router.model} · ` : ""}
                        {installedHere
                          ? t("router_card_installed")
                          : router.supported
                            ? t("router_card_protect_home")
                            : routerMeta(router)}
                      </div>
                    </div>
                    <svg className="devices-card__chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                )}
                {otherRouters.map((d) => (
                  <div key={d.device_id} className="devices-card">
                    <div className="devices-card__icon"><RouterIcon /></div>
                    <div className="devices-card__info">
                      <div className="devices-card__name">
                        {routerNameFor(d.hwid) || d.device_model || t("router_title")}
                      </div>
                      <div className="devices-card__meta">
                        {t("router_other_network")}
                        {routerNameFor(d.hwid) && d.device_model ? ` \u00B7 ${d.device_model}` : ""}
                        {d.last_seen_at ? ` \u00B7 ${formatEpochSecondsDateDots(d.last_seen_at)}` : ""}
                      </div>
                    </div>
                    <button
                      className="devices-card__disconnect"
                      onClick={() =>
                        setConfirming({
                          id: d.device_id,
                          name: routerNameFor(d.hwid) || d.device_model || t("router_title"),
                        })
                      }
                      disabled={unlinkingId !== null}
                    >
                      {t("devices_disconnect")}
                    </button>
                  </div>
                ))}
              </>
            )}

            <div className="devices-section-title">{t("devices_other_devices")}</div>
          </>
        )}
      </div>

      {isInitialLoading ? (
        <div className="spinner-center devices-spinner">
          <Spinner size={32} />
        </div>
      ) : (
        <ScrollEdgeAffordance className="devices-list" overlayFade>
          {isRefreshing ? (
            <>
              <DeviceCardSkeleton action />
              <DeviceCardSkeleton action />
            </>
          ) : otherDevices.length === 0 ? (
            <div className="devices-empty">{t("devices_empty")}</div>
          ) : (
            otherDevices.map((d) => (
              <div key={d.device_id} className="devices-card">
                <div className="devices-card__icon">{deviceTypeIcon(d)}</div>
                <div className="devices-card__info">
                  <div className="devices-card__name">{deviceName(d, personalHidden)}</div>
                  <div className="devices-card__meta">
                    {deviceTypeLabel(d)}
                    {d.platform ? ` \u00B7 ${d.platform}` : ""}
                    {d.last_seen_at ? ` \u00B7 ${formatEpochSecondsDateDots(d.last_seen_at)}` : ""}
                  </div>
                </div>
                <button
                  className="devices-card__disconnect"
                  onClick={() => setConfirming({ id: d.device_id, name: deviceName(d, personalHidden) })}
                  disabled={unlinkingId !== null}
                >
                  {t("devices_disconnect")}
                </button>
              </div>
            ))
          )}
        </ScrollEdgeAffordance>
      )}
      {confirming && (
        <UnlinkDeviceDialog
          name={confirming.name}
          onClose={() => setConfirming(null)}
          onConfirm={(reset) => handleUnlink(confirming.id, reset)}
        />
      )}
    </div>
  );
}

/**
 * Confirmation before a device leaves the account, with the choice to
 * reset the subscription link (on by default).
 */
function UnlinkDeviceDialog({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: (resetSubscription: boolean) => Promise<boolean>;
}) {
  const [resetLink, setResetLink] = useState(true);
  const [working, setWorking] = useState(false);
  return (
    <CenterDialog label={t("devices_unlink_title")} locked={working} onClose={onClose}>
      {(close) => (
        <div className="router-uninstall-sheet">
          <h2 className="whats-new-dialog__title">{t("devices_unlink_title")}</h2>
          <p className="router-uninstall-sheet__text">{tf("devices_unlink_text", name)}</p>
          <ResetLinkOption checked={resetLink} disabled={working} onChange={setResetLink} />
          <div className="router-bottom__buttons">
            <button type="button" className="router-button" disabled={working} onClick={() => close()}>
              {t("cancel")}
            </button>
            <button
              type="button"
              className="router-button router-button--danger-solid"
              disabled={working}
              onClick={async () => {
                setWorking(true);
                await onConfirm(resetLink);
                setWorking(false);
                close();
              }}
            >
              {working ? <Spinner size={16} /> : t("devices_unlink_confirm")}
            </button>
          </div>
        </div>
      )}
    </CenterDialog>
  );
}
