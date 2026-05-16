import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QRCodeSVG } from "qrcode.react";
import { t } from "../i18n";
import {
  authenticateWithTelegramId,
  clearPendingAuthToken,
  getPairingOpenTargets,
  createPairingCode,
  getPendingAuthToken,
  pollPairing,
} from "../session/auth";

const POLL_INTERVAL_MS = 2000;
const QR_RETRY_DELAY_MS = 3000;

export default function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingTelegram, setOpeningTelegram] = useState(false);
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;
    let retryTimer: number | null = null;

    const begin = async (reusePending = true) => {
      if (cancelled) return;
      setError(null);
      setAuthToken(null);
      setQrValue(null);
      const pendingAuthToken = reusePending ? getPendingAuthToken() : null;
      if (pendingAuthToken) {
        const { browserUrl } = getPairingOpenTargets(pendingAuthToken);
        setAuthToken(pendingAuthToken);
        setQrValue(browserUrl);
        scheduleNext(pendingAuthToken);
        return;
      }
      try {
        const { authToken: freshAuthToken, qrUrl } = await createPairingCode();
        if (cancelled) return;
        setAuthToken(freshAuthToken);
        setQrValue(qrUrl);
        scheduleNext(freshAuthToken);
      } catch (e) {
        if (cancelled) return;
        setError(messageOf(e));
        scheduleRetry();
      }
    };

    const scheduleNext = (currentAuthToken: string) => {
      if (cancelled) return;
      pollTimer = window.setTimeout(() => poll(currentAuthToken), POLL_INTERVAL_MS);
    };

    const scheduleRetry = () => {
      if (cancelled) return;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void begin(false);
      }, QR_RETRY_DELAY_MS);
    };

    const poll = async (currentAuthToken: string) => {
      if (cancelled) return;
      try {
        const result = await pollPairing(currentAuthToken);
        if (cancelled) return;
        if (result.status === "completed") {
          const payload = result.payload;
          try {
            await authenticateWithTelegramId(
              payload.telegram_id!,
              payload.short_uuid ?? null,
              null,
            );
            clearPendingAuthToken();
            if (!cancelled) onPairedRef.current();
          } catch (e) {
            if (!cancelled) setError(messageOf(e));
          }
          return;
        }
        if (result.status === "expired") {
          clearPendingAuthToken();
          await begin(false);
          return;
        }
        scheduleNext(currentAuthToken);
      } catch (e) {
        if (cancelled) return;
        setError(messageOf(e));
        scheduleNext(currentAuthToken);
      }
    };

    begin();
    return () => {
      cancelled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, []);

  const handleOpenTelegram = async () => {
    if (!authToken || openingTelegram) return;
    setOpeningTelegram(true);
    setError(null);
    const { desktopUrl, browserUrl } = getPairingOpenTargets(authToken);
    try {
      try {
        await openUrl(desktopUrl);
      } catch {
        await openUrl(browserUrl);
      }
    } catch (e) {
      setError(messageOf(e) || t("pairing_open_failed"));
    } finally {
      setOpeningTelegram(false);
    }
  };

  return (
    <div className="screen pairing">
      <div className="pairing__header">
        <div className="screen__title">{t("pairing_title")}</div>
        <div className="screen__subtitle">{t("pairing_subtitle")}</div>
      </div>

      <div className="pairing__qr">
        {qrValue ? (
          <QRCodeSVG value={qrValue} size={310} level="M" />
        ) : (
          <div style={{ width: 310, height: 310 }} />
        )}
      </div>

      <div className="pairing__actions">
        <button
          type="button"
          className="cta-pill pairing__action-btn"
          onClick={() => { void handleOpenTelegram(); }}
          disabled={!authToken || openingTelegram}
        >
          {openingTelegram ? t("pairing_opening_telegram") : t("pairing_open_telegram")}
        </button>
      </div>

      <div className={`pairing__hint ${error ? "pairing__hint--error" : ""}`}>
        {error ?? (authToken ? t("pairing_waiting") : t("pairing_waiting"))}
      </div>
    </div>
  );
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
