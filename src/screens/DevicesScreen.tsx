import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { fetchDevices, getCurrentDeviceAliases, unlinkOtherDevice } from "../session/auth";
import { formatEpochSecondsDateDots } from "../session/dateFormat";
import Spinner from "../components/Spinner";
import type { LinkedDeviceDto } from "../api/types";
import "./DevicesScreen.css";

type DeviceKind = "phone" | "desktop" | "tv";

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

export default function DevicesScreen({ onBack }: { onBack: () => void }) {
  const [devices, setDevices] = useState<LinkedDeviceDto[]>([]);
  const [maxDevices, setMaxDevices] = useState(0);
  const [currentCount, setCurrentCount] = useState<number | null>(null);
  const [currentAliases, setCurrentAliases] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const unlinkGenerationRef = useRef(0);
  const unlinkingRef = useRef(false);
  const mountedRef = useRef(true);

  const load = async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const [data, aliases] = await Promise.all([
        fetchDevices(),
        getCurrentDeviceAliases(),
      ]);
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
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current++;
      unlinkGenerationRef.current++;
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
        <button className="devices-topbar__action" onClick={load} disabled={loading}>
          <svg
            className={loading ? "devices-topbar__action-icon devices-topbar__action-icon--spinning" : "devices-topbar__action-icon"}
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

      <div className="devices-content">
        {error && (
          <button type="button" className="devices-error" onClick={() => void load()}>
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
        {loading ? (
          <div className="spinner-center">
            <Spinner size={32} />
          </div>
        ) : otherDevices.length === 0 ? (
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
      </div>
    </div>
  );
}
