import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { fetchDevices, getCurrentDeviceAliases, unlinkOtherDevice } from "../session/auth";
import { formatEpochSecondsDateDots } from "../session/dateFormat";
import Spinner from "../components/Spinner";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import type { LinkedDeviceDto } from "../api/types";
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

function deviceName(dto: LinkedDeviceDto): string {
  const kind = inferDeviceKind(dto);
  if (kind === "desktop") {
    const name = dto.device_name?.trim() ?? "";
    if (name && !isTechnicalDesktopName(name)) return name;
    const model = cleanDesktopModel(dto.device_model, dto.platform);
    if (model) return model;
    const platform = dto.platform?.trim();
    return platform ? `${t("devices_type_desktop")} ${platform}` : t("devices_type_desktop");
  }
  return dto.device_name?.trim() || dto.device_model?.trim() || deviceTypeLabel(dto);
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

function DevicesRefreshSkeleton({ showCurrent }: { showCurrent: boolean }) {
  return (
    <>
      {showCurrent && (
        <>
          <div className="devices-section-title">{t("devices_this_device")}</div>
          <DeviceCardSkeleton action />
        </>
      )}
      <div className="devices-section-title">{t("devices_other_devices")}</div>
      <DeviceCardSkeleton action />
      <DeviceCardSkeleton action />
    </>
  );
}

export default function DevicesScreen({ onBack }: { onBack: () => void }) {
  const [devices, setDevices] = useState<LinkedDeviceDto[]>([]);
  const [maxDevices, setMaxDevices] = useState(0);
  const [currentCount, setCurrentCount] = useState<number | null>(null);
  const [currentAliases, setCurrentAliases] = useState<string[]>([]);
  const [isInitialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setRefreshing] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const unlinkGenerationRef = useRef(0);
  const unlinkingRef = useRef(false);
  const mountedRef = useRef(true);

  const load = async (refresh = false) => {
    const generation = ++loadGenerationRef.current;
    const refreshStartedAt = refresh ? performance.now() : null;
    setInitialLoading(!refresh);
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
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      unlinkGenerationRef.current += 1;
      unlinkingRef.current = false;
    };
  }, []);

  const handleUnlink = async (deviceId: string) => {
    if (unlinkingRef.current) return;
    unlinkingRef.current = true;
    const generation = ++unlinkGenerationRef.current;
    setUnlinkingId(deviceId);
    setError(null);
    try {
      await unlinkOtherDevice(deviceId);
      if (!mountedRef.current || generation !== unlinkGenerationRef.current) return;
      setDevices((prev) => prev.filter((d) => d.device_id !== deviceId));
      setCurrentCount((count) =>
        count === null ? null : Math.max(0, count - 1),
      );
    } catch {
      if (mountedRef.current && generation === unlinkGenerationRef.current) {
        setError(t("devices_unlink_error"));
      }
    } finally {
      if (generation === unlinkGenerationRef.current) {
        unlinkingRef.current = false;
        if (mountedRef.current) setUnlinkingId(null);
      }
    }
  };

  const devicesCount = currentCount ?? devices.length;
  const currentDevice = devices.find((d) => deviceMatchesAliases(d, currentAliases));
  const otherDevices = devices.filter((d) => !deviceMatchesAliases(d, currentAliases));

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

      <ScrollEdgeAffordance className="devices-content">
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

        {isInitialLoading ? (
          <div className="spinner-center">
            <Spinner size={32} />
          </div>
        ) : isRefreshing ? (
          <DevicesRefreshSkeleton showCurrent={currentDevice !== undefined} />
        ) : (
          <>
            {/* Current device */}
            {currentDevice && (
              <>
                <div className="devices-section-title">{t("devices_this_device")}</div>
                <div className="devices-card devices-card--current">
                  <div className="devices-card__icon">{deviceTypeIcon(currentDevice)}</div>
                  <div className="devices-card__info">
                    <div className="devices-card__name">
                      {deviceName(currentDevice)}
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

            {/* Other devices */}
            <div className="devices-section-title">{t("devices_other_devices")}</div>
            {otherDevices.length === 0 ? (
              <div className="devices-empty">{t("devices_empty")}</div>
            ) : (
              otherDevices.map((d) => (
                <div key={d.device_id} className="devices-card">
                  <div className="devices-card__icon">{deviceTypeIcon(d)}</div>
                  <div className="devices-card__info">
                    <div className="devices-card__name">{deviceName(d)}</div>
                    <div className="devices-card__meta">
                      {deviceTypeLabel(d)}
                      {d.platform ? ` \u00B7 ${d.platform}` : ""}
                      {d.last_seen_at ? ` \u00B7 ${formatEpochSecondsDateDots(d.last_seen_at)}` : ""}
                    </div>
                  </div>
                  <button
                    className="devices-card__disconnect"
                    onClick={() => handleUnlink(d.device_id)}
                    disabled={unlinkingId !== null}
                  >
                    {t("devices_disconnect")}
                  </button>
                </div>
              ))
            )}
          </>
        )}
      </ScrollEdgeAffordance>
    </div>
  );
}
