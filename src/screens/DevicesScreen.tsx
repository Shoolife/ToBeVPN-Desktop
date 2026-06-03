import { useEffect, useState } from "react";
import { t } from "../i18n";
import { fetchDevices, unlinkOtherDevice } from "../session/auth";
import { getSession } from "../session/store";
import { formatEpochSecondsDateDots } from "../session/dateFormat";
import Spinner from "../components/Spinner";
import type { LinkedDeviceDto } from "../api/types";
import "./DevicesScreen.css";

function deviceTypeLabel(dto: LinkedDeviceDto): string {
  const type = (dto.device_type ?? "").toLowerCase();
  if (type === "tv") return t("devices_type_tv");
  if (type === "desktop") return t("devices_type_desktop");
  return t("devices_type_phone");
}

function deviceTypeIcon(dto: LinkedDeviceDto): React.ReactNode {
  const type = (dto.device_type ?? "").toLowerCase();
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

export default function DevicesScreen({ onBack }: { onBack: () => void }) {
  const [devices, setDevices] = useState<LinkedDeviceDto[]>([]);
  const [maxDevices, setMaxDevices] = useState(0);
  const [loading, setLoading] = useState(true);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const currentDeviceId = getSession().deviceId;

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchDevices();
      if (data) {
        setDevices(data.devices);
        setMaxDevices(data.max_devices);
      }
    } catch {
      // keep previous state
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleUnlink = async (deviceId: string) => {
    setUnlinkingId(deviceId);
    try {
      await unlinkOtherDevice(deviceId);
      setDevices((prev) => prev.filter((d) => d.device_id !== deviceId));
    } catch {
      // ignore
    } finally {
      setUnlinkingId(null);
    }
  };

  const currentDevice = devices.find((d) => d.device_id === currentDeviceId);
  const otherDevices = devices.filter((d) => d.device_id !== currentDeviceId);

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
        {/* Counter */}
        <div className="devices-counter">
          <span className="devices-counter__count">
            {maxDevices === 0 ? devices.length : `${devices.length}/${maxDevices}`}
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
                  {currentDevice.device_name ?? "Unknown"}
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
                <div className="devices-card__name">{d.device_name ?? "Unknown"}</div>
                <div className="devices-card__meta">
                  {deviceTypeLabel(d)}
                  {d.platform ? ` \u00B7 ${d.platform}` : ""}
                  {d.last_seen_at ? ` \u00B7 ${formatEpochSecondsDateDots(d.last_seen_at)}` : ""}
                </div>
              </div>
              <button
                className="devices-card__disconnect"
                onClick={() => handleUnlink(d.device_id)}
                disabled={unlinkingId === d.device_id}
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
