import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import Spinner from "../components/Spinner";
import { detectRouter, getCachedRouter, routerFirmwareLabel, type RouterInfo } from "../session/router";
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

export default function RouterScreen({ onBack }: { onBack: () => void }) {
  const [info, setInfo] = useState<RouterInfo | null>(() => getCachedRouter());
  const [loading, setLoading] = useState(info === null);
  const [refreshing, setRefreshing] = useState(false);
  const generationRef = useRef(0);

  const load = async (refresh: boolean) => {
    const generation = ++generationRef.current;
    const startedAt = performance.now();
    setRefreshing(refresh);
    const next = await detectRouter(refresh);
    if (refresh) {
      const remaining = MIN_REFRESH_FEEDBACK_MS - (performance.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
    }
    if (generation !== generationRef.current) return;
    setInfo(next);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    void load(false);
    return () => {
      generationRef.current += 1;
    };
  }, []);

  const detected = !!info?.model;
  const status = !info?.gateway
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
          disabled={loading || refreshing}
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
              <div className="devices-card__name">
                {detected ? info.model : t("router_not_detected")}
              </div>
              {routerMeta(info) && <div className="devices-card__meta">{routerMeta(info)}</div>}
            </div>
            {info.supported && <span className="devices-card__badge">{t("router_supported_badge")}</span>}
          </div>
          <p className="router-status">{status}</p>

          <div className="devices-section-title">{t("router_vpn_section")}</div>
          <div className="router-panel">
            <p className="router-panel__text">{t("router_vpn_description")}</p>
            <button type="button" className="router-panel__action" disabled>
              {t("router_install")}
            </button>
            <p className="router-panel__hint">
              {info.supported ? t("router_install_soon") : t("router_install_unsupported")}
            </p>
          </div>

          <div className="devices-section-title">{t("router_home_network_section")}</div>
          <div className="router-panel">
            <p className="router-panel__text">{t("router_home_network_description")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
