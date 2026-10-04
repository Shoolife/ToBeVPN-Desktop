import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QRCodeSVG } from "qrcode.react";
import { t } from "../i18n";
import DemoLoginDialog from "../components/DemoLoginDialog";
import MaterialIcon from "../components/MaterialIcon";
import brandLogo from "../assets/onboarding_logo.svg";
import "./PairingScreen.css";
import {
  authenticateWithTelegramId,
  clearPendingAuthToken,
  completeDemoLogin,
  createDevicePairingCode,
  getPairingOpenTargets,
  createPairingCode,
  pollDevicePairing,
  pollPairing,
} from "../session/auth";

const POLL_INTERVAL_MS = 2000;
const DEMO_LOGIN_HOLD_MS = 2000;
// Not a real secret — it only gates a local-only stub session for store
// review, never a backend account. See completeDemoLogin in session/auth.ts.
const DEMO_LOGIN_PIN = "483920";
const QR_RETRY_DELAY_MS = 3000;
type CopiedTarget = "code";

// Sign-in in the same two steps as the TV client: first choose how to sign
// in (phone app, iPhone or no app), then the QR / code for that route.
type PairingEntry = "app" | "iphone" | "no_phone";

const GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=com.tobevpn.app";

/** Same duration as the app's screen transitions (App.tsx DURATION). */
const STEP_TRANSITION_MS = 300;

export default function PairingScreen({ onPaired, wide = false }: { onPaired: () => void; wide?: boolean }) {
  const [entry, setEntry] = useState<PairingEntry | null>(null);
  // Step changes crossfade with the app's screen timing: the new step fades in
  // while a static copy of the old one fades out on top (PairingScreen.css).
  // False on the first render, so the screen itself does not animate twice.
  const [stepAnimated, setStepAnimated] = useState(false);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const stepStartTimerRef = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const playStepExit = () => {
    const screen = screenRef.current;
    const content = contentRef.current;
    if (!screen || !content) return;
    const ghost = content.cloneNode(true) as HTMLElement;
    ghost.classList.remove("auth-step-enter");
    ghost.classList.add("auth-step-exit");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    // Exactly over the step it copies. Inset 0 ignored the screen's padding
    // (the shared .screen style) and the copy sat 32px off, so the QR seemed
    // to slide left and back.
    ghost.style.left = `${content.offsetLeft}px`;
    ghost.style.top = `${content.offsetTop}px`;
    ghost.style.width = `${content.offsetWidth}px`;
    ghost.style.height = `${content.offsetHeight}px`;
    screen.appendChild(ghost);
    window.setTimeout(() => ghost.remove(), STEP_TRANSITION_MS);
  };
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
  const [showDemoLogin, setShowDemoLogin] = useState(false);
  const demoHoldTimerRef = useRef<number | null>(null);

  // Hidden entry point for store review: hold the title to open a PIN-gated
  // demo login that never touches the real backend (same as the TV client).
  const startDemoHold = () => {
    cancelDemoHold();
    demoHoldTimerRef.current = window.setTimeout(() => {
      demoHoldTimerRef.current = null;
      setShowDemoLogin(true);
    }, DEMO_LOGIN_HOLD_MS);
  };
  const cancelDemoHold = () => {
    if (demoHoldTimerRef.current !== null) {
      clearTimeout(demoHoldTimerRef.current);
      demoHoldTimerRef.current = null;
    }
  };
  const submitDemoPin = (pin: string) => {
    if (pin.trim() !== DEMO_LOGIN_PIN) return false;
    flowGenerationRef.current += 1;
    clearTimers();
    setShowDemoLogin(false);
    completeDemoLogin();
    onPairedRef.current();
    return true;
  };

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
    return () => {
      mountedRef.current = false;
      flowGenerationRef.current += 1;
      openingTelegramRef.current = false;
      authenticatingRef.current = false;
      clearTimers();
      cancelDemoHold();
      if (stepStartTimerRef.current !== null) window.clearTimeout(stepStartTimerRef.current);
    };
  }, []);

  const beginTelegramPairing = async () => {
    if (authenticatingRef.current) return;
    const generation = ++flowGenerationRef.current;
    clearTimers();
    openingTelegramRef.current = false;
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

  const chooseEntry = (next: PairingEntry) => {
    playStepExit();
    setStepAnimated(true);
    setEntry(next);
    // Start the sign-in request once the transition is over: its state
    // updates (spinner -> QR) would otherwise repaint the step mid-fade.
    if (stepStartTimerRef.current !== null) window.clearTimeout(stepStartTimerRef.current);
    const generation = flowGenerationRef.current;
    stepStartTimerRef.current = window.setTimeout(() => {
      stepStartTimerRef.current = null;
      if (!mountedRef.current || flowGenerationRef.current !== generation) return;
      if (next === "app") void beginDevicePairing();
      else void beginTelegramPairing();
    }, STEP_TRANSITION_MS);
  };

  const backToChooser = () => {
    if (authenticatingRef.current) return;
    if (stepStartTimerRef.current !== null) {
      window.clearTimeout(stepStartTimerRef.current);
      stepStartTimerRef.current = null;
    }
    flowGenerationRef.current += 1;
    clearTimers();
    clearPendingAuthToken();
    openingTelegramRef.current = false;
    setOpeningTelegram(false);
    setAuthToken(null);
    setPairingCode(null);
    setQrValue(null);
    setError(null);
    playStepExit();
    setStepAnimated(true);
    setEntry(null);
  };

  const retry = () => {
    if (entry === "app") void beginDevicePairing();
    else void beginTelegramPairing();
  };

  // Demo sign-in for Microsoft Store review (and the vite dev server): hold
  // the title. Release desktop builds never wire it up.
  const demoHoldProps = import.meta.env.VITE_STORE_BUILD || import.meta.env.DEV
    ? {
        onPointerDown: startDemoHold,
        onPointerUp: cancelDemoHold,
        onPointerLeave: cancelDemoHold,
        onPointerCancel: cancelDemoHold,
      }
    : {};

  const demoDialog = showDemoLogin && (
    <DemoLoginDialog onDismiss={() => setShowDemoLogin(false)} onSubmit={submitDemoPin} />
  );

  if (entry === null) {
    return (
      <div ref={screenRef} className={`screen auth-screen ${wide ? "auth-screen--wide" : ""}`}>
        <div
          key="chooser"
          ref={contentRef}
          className={`auth-screen__content ${stepAnimated ? "auth-step-enter" : ""}`}
        >
          <div className="auth-visual">
          <div className="auth-qr-panel auth-qr-panel--store">
            <div className="auth-qr-plate">
              <QRCodeSVG value={GOOGLE_PLAY_URL} size={180} level="M" aria-label={t("install_qr_content_description")} />
            </div>
            <div className="auth-store-badge">
              <GooglePlayIcon />
              <div className="auth-store-badge__text">
                <span className="auth-store-badge__hint">{t("install_store_available_in")}</span>
                <span className="auth-store-badge__name">{t("install_store_badge")}</span>
              </div>
            </div>
          </div>
          </div>

          <div className="auth-body">
          <h1 className="auth-title" {...demoHoldProps}>
            <AccentedText full={t("install_title")} accent={t("install_title_accent")} />
          </h1>
          <p className="auth-text">{t("install_description")}</p>

          <div className="auth-actions">
            <button type="button" className="auth-btn auth-btn--primary" onClick={() => chooseEntry("app")}>
              <MaterialIcon name="checkCircle" size={22} />
              <span>{t("install_done")}</span>
            </button>
            <button type="button" className="auth-btn" onClick={() => chooseEntry("iphone")}>
              <MaterialIcon name="phoneIphone" size={22} />
              <span>{t("install_iphone")}</span>
            </button>
            <button type="button" className="auth-btn" onClick={() => chooseEntry("no_phone")}>
              <MaterialIcon name="login" size={22} />
              <span>{t("install_no_phone")}</span>
            </button>
          </div>
          </div>
        </div>
        {demoDialog}
      </div>
    );
  }

  const usesTelegram = entry !== "app";
  const title =
    entry === "app" ? t("pairing_title_app")
    : entry === "iphone" ? t("pairing_title_iphone")
    : t("pairing_title_telegram");
  const instruction =
    entry === "app" ? t("pairing_instruction_app")
    : entry === "iphone" ? t("pairing_instruction_iphone")
    : t("pairing_instruction_telegram");
  const status =
    error ?? (qrValue
      ? (usesTelegram ? t("pairing_waiting_telegram") : t("pairing_waiting_app"))
      : (usesTelegram ? t("pairing_loading_telegram") : t("pairing_loading_app")));

  return (
    <div ref={screenRef} className={`screen auth-screen ${wide ? "auth-screen--wide" : ""}`}>
      <div
          key={entry}
          ref={contentRef}
          className={`auth-screen__content ${stepAnimated ? "auth-step-enter" : ""}`}
        >
        <div className="auth-visual">
        <div className={`auth-qr-panel ${usesTelegram ? "" : "auth-qr-panel--store auth-qr-panel--tobevpn"}`}>
          <div className="auth-qr-plate">
            {authenticating ? (
              <span className="auth-qr-plate__state">{t("auth_waiting")}</span>
            ) : qrValue ? (
              <QRCodeSVG value={qrValue} size={200} level="M" />
            ) : (
              <span className="auth-spinner" aria-hidden="true" />
            )}
          </div>
          {!usesTelegram && (
            <div className="auth-store-badge">
              <img className="auth-store-badge__logo" src={brandLogo} alt="" aria-hidden="true" />
              <span className="auth-store-badge__name">ToBeVPN {t("pairing_app_badge_hint")}</span>
            </div>
          )}
        </div>

        {usesTelegram && (
          <button
            type="button"
            className="auth-telegram-caption"
            onClick={() => { void openCurrentTelegramPairing(); }}
            disabled={!authToken || openingTelegram || authenticating}
          >
            <TelegramIcon />
            <span>
              {openingTelegram
                ? t("pairing_opening_telegram")
                : <AccentedText full={t("pairing_open_telegram_bot")} accent={t("pairing_open_telegram_bot_accent")} />}
            </span>
          </button>
        )}
        </div>

        <div className="auth-body">
        <h1 className="auth-title" {...demoHoldProps}>
          <AccentedText full={title} accent={entry === "no_phone" ? t("pairing_title_telegram_accent") : ""} />
        </h1>
        <p className="auth-text">{instruction}</p>

        {entry === "app" && pairingCode && (
          <div className="auth-code-chip">
            <span className="auth-code-chip__label">{t("pairing_code_label")}</span>
            <span className="auth-code-chip__value">{pairingCode}</span>
            <button
              type="button"
              className="auth-code-chip__copy"
              onClick={() => void copyPairingValue(pairingCode, "code")}
              aria-label={copiedTarget === "code" ? t("pairing_copied") : t("pairing_copy_code")}
              title={copiedTarget === "code" ? t("pairing_copied") : t("pairing_copy_code")}
            >
              {copiedTarget === "code" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
        )}

        {!authenticating && (
          <div className={`auth-status ${usesTelegram ? "" : "auth-status--tobevpn"} ${error ? "auth-status--error" : ""}`} role="status">
            <span className="auth-status__dot" aria-hidden="true" />
            <span>{status}</span>
          </div>
        )}

        <div className="auth-actions auth-actions--inline">
          {error && (
            <button type="button" className="auth-btn" onClick={retry}>
              <MaterialIcon name="refresh" size={22} />
              <span>{t("retry")}</span>
            </button>
          )}
          <button type="button" className="auth-btn" onClick={backToChooser} disabled={authenticating}>
            <MaterialIcon name="arrowBack" size={22} />
            <span>{t("back")}</span>
          </button>
        </div>
        </div>
      </div>
      {demoDialog}
    </div>
  );
}

/** Paints `accent` inside `full` in the brand green, as on the TV. */
function AccentedText({ full, accent }: { full: string; accent: string }) {
  const start = accent ? full.indexOf(accent) : -1;
  if (start < 0) return <>{full}</>;
  return (
    <>
      {full.slice(0, start)}
      <span className="auth-accent">{accent}</span>
      {full.slice(start + accent.length)}
    </>
  );
}

function TelegramIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#29B6F6" d="M24,4A20,20 0,1 0,24 44A20,20 0,1 0,24 4" />
      <path fill="#FFFFFF" d="M33.95,15l-3.746,19.126c0,0 -0.161,0.874 -1.245,0.874 -0.576,0 -0.873,-0.274 -0.873,-0.274l-8.114,-6.733 -3.97,-2.001 -5.095,-1.355c0,0 -0.907,-0.262 -0.907,-1.012 0,-0.625 0.933,-0.923 0.933,-0.923l21.316,-8.468c-0.001,-0.001 0.651,-0.235 1.126,-0.234C33.667,14 34,14.125 34,14.5 34,14.75 33.95,15 33.95,15z" />
      <path fill="#B0BEC5" d="M23,30.505l-3.426,3.374c0,0 -0.149,0.115 -0.348,0.12 -0.069,0.002 -0.143,-0.009 -0.219,-0.043l0.964,-5.965L23,30.505z" />
      <path fill="#CFD8DC" d="M29.897,18.196c-0.169,-0.22 -0.481,-0.26 -0.701,-0.093L16,26c0,0 2.106,5.892 2.427,6.912 0.322,1.021 0.58,1.045 0.58,1.045l0.964,-5.965 9.832,-9.096C30.023,18.729 30.064,18.416 29.897,18.196z" />
    </svg>
  );
}

function GooglePlayIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 40 40" aria-hidden="true">
      <path fill="#EA4335" d="M19.7,19.2 L4.3,35.3c0.5,1.7 2.1,3 4,3 0.8,0 1.5,-0.2 2.1,-0.6l17.4,-9.9 -8.1,-8.6z" />
      <path fill="#FBBC04" d="M35.3,16.4 L27.8,12.1 19.4,19.5 27.9,27.8 35.4,23.6c1.3,-0.7 2.2,-2.1 2.2,-3.6 -0.1,-1.5 -1,-2.9 -2.3,-3.6z" />
      <path fill="#4285F4" d="M4.3,4.7c-0.1,0.3 -0.1,0.7 -0.1,1.1v28.5c0,0.4 0,0.7 0.1,1.1l16,-15.7 -16,-15z" />
      <path fill="#34A853" d="M19.8,20 L27.8,12.1 10.5,2.3c-0.6,-0.4 -1.4,-0.6 -2.2,-0.6 -1.9,0 -3.6,1.3 -4,3L19.8,20z" />
    </svg>
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
