import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QRCodeSVG } from "qrcode.react";
import { t } from "../i18n";
import {
  authenticateWithTelegramId,
  clearPendingAuthToken,
  createDevicePairingCode,
  getPairingOpenTargets,
  createPairingCode,
  pollDevicePairing,
  pollPairing,
} from "../session/auth";

const POLL_INTERVAL_MS = 2000;
const QR_RETRY_DELAY_MS = 3000;
type PairingMode = "device" | "telegram";
type CopiedTarget = "code";

export default function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const [mode, setMode] = useState<PairingMode>("telegram");
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingTelegram, setOpeningTelegram] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<CopiedTarget | null>(null);
  const onPairedRef = useRef(onPaired);
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const flowGenerationRef = useRef(0);
  const openingTelegramRef = useRef(false);
  const authenticatingRef = useRef(false);
  onPairedRef.current = onPaired;

  const clearTimers = () => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  };

  const beginDevicePairing = async () => {
    if (!mountedRef.current || authenticatingRef.current) return;
    const generation = ++flowGenerationRef.current;
    clearTimers();
    clearPendingAuthToken();
    setMode("device");
    setError(null);
    openingTelegramRef.current = false;
    setOpeningTelegram(false);
    setAuthToken(null);
    setPairingCode(null);
    setQrValue(null);
    setCopiedTarget(null);
    try {
      const { code } = await createDevicePairingCode();
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setPairingCode(code);
      setQrValue(createPairingDeepLink(code));
      scheduleDevicePoll(code, generation);
    } catch (e) {
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setError(messageOf(e));
      scheduleDeviceRetry(generation);
    }
  };

  const scheduleDevicePoll = (code: string, generation: number) => {
    if (!mountedRef.current || generation !== flowGenerationRef.current) return;
    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = null;
      void pollDevice(code, generation);
    }, POLL_INTERVAL_MS);
  };

  const scheduleDeviceRetry = (generation: number) => {
    if (!mountedRef.current || generation !== flowGenerationRef.current) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (generation !== flowGenerationRef.current) return;
      void beginDevicePairing();
    }, QR_RETRY_DELAY_MS);
  };

  const pollDevice = async (code: string, generation: number) => {
    if (!mountedRef.current || generation !== flowGenerationRef.current) return;
    try {
      const result = await pollDevicePairing(code);
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setError(null);
      if (result.status === "completed") {
        const payload = result.payload;
        authenticatingRef.current = true;
        setAuthenticating(true);
        try {
          await authenticateWithTelegramId(
            payload.telegram_id!,
            payload.short_uuid ?? null,
            payload.panel_user_uuid ?? null,
          );
        } catch (authError) {
          if (mountedRef.current && generation === flowGenerationRef.current) {
            authenticatingRef.current = false;
            setAuthenticating(false);
          }
          throw authError;
        }
        if (mountedRef.current && generation === flowGenerationRef.current) {
          onPairedRef.current();
        }
        return;
      }
      if (result.status === "expired") {
        await beginDevicePairing();
        return;
      }
      scheduleDevicePoll(code, generation);
    } catch (e) {
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setError(messageOf(e));
      scheduleDevicePoll(code, generation);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void beginTelegramPairing();
    return () => {
      mountedRef.current = false;
      flowGenerationRef.current += 1;
      openingTelegramRef.current = false;
      authenticatingRef.current = false;
      clearTimers();
    };
  }, []);

  const beginTelegramPairing = async () => {
    if (authenticatingRef.current) return;
    const generation = ++flowGenerationRef.current;
    clearTimers();
    openingTelegramRef.current = false;
    setMode("telegram");
    setOpeningTelegram(false);
    setError(null);
    setPairingCode(null);
    setCopiedTarget(null);
    try {
      const { authToken: freshAuthToken, qrUrl } = await createPairingCode();
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setAuthToken(freshAuthToken);
      setQrValue(qrUrl);
      scheduleTelegramPoll(freshAuthToken, generation);
    } catch (e) {
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setError(messageOf(e));
    }
  };

  const openCurrentTelegramPairing = async () => {
    if (
      !authToken ||
      authenticatingRef.current ||
      openingTelegramRef.current ||
      !mountedRef.current
    ) return;
    const generation = flowGenerationRef.current;
    const { desktopUrl, browserUrl } = getPairingOpenTargets(authToken);
    openingTelegramRef.current = true;
    setOpeningTelegram(true);
    setError(null);
    try {
      try {
        await openUrl(desktopUrl);
      } catch {
        if (!mountedRef.current || generation !== flowGenerationRef.current) return;
        await openUrl(browserUrl);
      }
    } catch (e) {
      if (mountedRef.current && generation === flowGenerationRef.current) {
        setError(messageOf(e) || t("pairing_open_failed"));
      }
    } finally {
      if (mountedRef.current && generation === flowGenerationRef.current) {
        openingTelegramRef.current = false;
        setOpeningTelegram(false);
      }
    }
  };

  const scheduleTelegramPoll = (currentAuthToken: string, generation: number) => {
    if (!mountedRef.current || generation !== flowGenerationRef.current) return;
    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = null;
      void pollTelegram(currentAuthToken, generation);
    }, POLL_INTERVAL_MS);
  };

  const pollTelegram = async (currentAuthToken: string, generation: number) => {
    if (!mountedRef.current || generation !== flowGenerationRef.current) return;
    try {
      const result = await pollPairing(currentAuthToken);
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setError(null);
      if (result.status === "completed") {
        const payload = result.payload;
        authenticatingRef.current = true;
        setAuthenticating(true);
        try {
          await authenticateWithTelegramId(
            payload.telegram_id!,
            payload.short_uuid ?? null,
            null,
          );
        } catch (authError) {
          if (mountedRef.current && generation === flowGenerationRef.current) {
            authenticatingRef.current = false;
            setAuthenticating(false);
          }
          throw authError;
        }
        clearPendingAuthToken();
        if (mountedRef.current && generation === flowGenerationRef.current) {
          onPairedRef.current();
        }
        return;
      }
      if (result.status === "expired") {
        clearPendingAuthToken();
        await beginTelegramPairing();
        return;
      }
      scheduleTelegramPoll(currentAuthToken, generation);
    } catch (e) {
      if (!mountedRef.current || generation !== flowGenerationRef.current) return;
      setError(messageOf(e));
      scheduleTelegramPoll(currentAuthToken, generation);
    }
  };

  const selectMode = (nextMode: PairingMode) => {
    if (authenticatingRef.current || nextMode === mode) return;
    if (nextMode === "telegram") {
      void beginTelegramPairing();
    } else {
      void beginDevicePairing();
    }
  };

  const copyPairingValue = async (value: string, target: CopiedTarget) => {
    try {
      await navigator.clipboard.writeText(value);
      if (!mountedRef.current) return;
      setCopiedTarget(target);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedTarget(null);
        copyTimerRef.current = null;
      }, 1600);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(messageOf(e));
    }
  };

  return (
    <div className="screen pairing">
      <div className="pairing__header">
        <div className="screen__title">{t("pairing_title")}</div>
        <div className="screen__subtitle">
          {mode === "telegram" ? t("pairing_subtitle_telegram") : t("pairing_subtitle_device")}
        </div>
      </div>

      <div className="pairing__mode-switch" role="tablist" aria-label={t("pairing_mode_label")}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "telegram"}
          disabled={authenticating}
          className={`pairing__mode-btn ${mode === "telegram" ? "pairing__mode-btn--active" : ""}`}
          onClick={() => selectMode("telegram")}
        >
          {t("pairing_mode_telegram")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "device"}
          disabled={authenticating}
          className={`pairing__mode-btn ${mode === "device" ? "pairing__mode-btn--active" : ""}`}
          onClick={() => selectMode("device")}
        >
          {t("pairing_mode_device")}
        </button>
      </div>

      <div className="pairing__qr">
        {qrValue ? (
          <QRCodeSVG className="pairing__qr-svg" value={qrValue} size={310} level="M" />
        ) : (
          <div className="pairing__qr-placeholder" />
        )}
      </div>

      {mode === "device" && pairingCode ? (
        <div className="pairing__code">
          <span className="pairing__code-value">{pairingCode}</span>
          <button
            type="button"
            className="pairing__copy-btn"
            onClick={() => void copyPairingValue(pairingCode, "code")}
            aria-label={copiedTarget === "code" ? t("pairing_copied") : t("pairing_copy_code")}
            title={copiedTarget === "code" ? t("pairing_copied") : t("pairing_copy_code")}
          >
            {copiedTarget === "code" ? (
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </div>
      ) : null}

      {mode === "telegram" ? (
        <div className="pairing__actions">
          <button
            type="button"
            className="cta-pill pairing__action-btn"
            onClick={() => { void openCurrentTelegramPairing(); }}
            disabled={!authToken || openingTelegram || authenticating}
          >
            {openingTelegram ? t("pairing_opening_telegram") : t("pairing_open_telegram")}
          </button>
        </div>
      ) : null}

      <div className={`pairing__hint ${error ? "pairing__hint--error" : ""}`}>
        {error ?? (mode === "telegram" && authToken
          ? t("pairing_waiting_telegram")
          : t("pairing_waiting"))}
      </div>
    </div>
  );
}

function messageOf(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (
    /forbidden:\s*not authorized/i.test(message) ||
    /"errorCode"\s*:\s*403/i.test(message) ||
    /clienterror/i.test(message) ||
    /fallback route rejected/i.test(message) ||
    /network request failed/i.test(message) ||
    /request timed out/i.test(message) ||
    /not authorized/i.test(message) ||
    /not authenticated/i.test(message) ||
    /http\s*403/i.test(message)
  ) {
    return t("pairing_load_error");
  }
  return message.trim() ? message : t("pairing_load_error");
}

function createPairingDeepLink(code: string): string {
  return `tobevpn://pair?code=${encodeURIComponent(code)}`;
}
