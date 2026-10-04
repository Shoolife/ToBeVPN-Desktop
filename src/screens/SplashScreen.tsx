import { useEffect, useRef, useState } from "react";
import { getSavedLang, t } from "../i18n";
import { initializeAuthSession } from "../session/auth";
import {
  clearStartupUpdateFailure,
  ensureInitialCheck,
  getAutoUpdateEnabled,
  useUpdateState,
  type DesktopUpdateState,
} from "../session/updateStore";
import "./SplashScreen.css";
import { mainWindowPresented } from "../session/windowPresentation";

type StartupPhase = "checking" | "starting" | "failed" | "relaunching";
type StartupIcon = "check" | "download" | "install" | "launch" | "restart" | "warning";

interface StartupPresentation {
  tone: "neutral" | "active" | "success" | "warning";
  icon: StartupIcon;
  label: string;
  title: string;
  description: string;
  showProgress: boolean;
  indeterminate: boolean;
  progress?: number;
  detail?: string;
  percent?: number;
}

export default function SplashScreen({
  onDone,
  browserPreview = false,
  wide = false,
}: {
  onDone: () => void;
  browserPreview?: boolean;
  /** Landscape window (startup that leads to sign-in): shield left, text right. */
  wide?: boolean;
}) {
  const onDoneRef = useRef(onDone);
  const updateState = useUpdateState();
  const [phase, setPhase] = useState<StartupPhase>(() =>
    !browserPreview && getAutoUpdateEnabled() ? "checking" : "starting",
  );
  const [leaving, setLeaving] = useState(false);
  const [presented, setPresented] = useState(false);

  // Keep the entrance animation paused while the native window is hidden.
  useEffect(() => {
    let active = true;
    void mainWindowPresented.then(() => {
      if (active) setPresented(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (browserPreview) return;

    let cancelled = false;
    let failureTimer: number | null = null;
    let leaveTimer: number | null = null;
    let doneTimer: number | null = null;

    void (async () => {
      // The hold time counts from when the window is actually on screen.
      const presentedAt = mainWindowPresented.then(() => performance.now());

      if (getAutoUpdateEnabled()) {
        setPhase("checking");
        const updateResult = await ensureInitialCheck();
        if (cancelled) return;

        if (updateResult === "relaunching") {
          // A successful relaunch normally terminates this process before the
          // promise settles. If the platform takes a moment, keep the user on
          // the explicit restart state instead of opening the old UI.
          setPhase("relaunching");
          return;
        }

        if (updateResult === "failed") {
          setPhase("failed");
          // An offline check can fail before the window is even shown; the
          // error must stay on screen for its full hold time.
          await mainWindowPresented;
          if (cancelled) return;
          await new Promise<void>((resolve) => {
            failureTimer = window.setTimeout(resolve, STARTUP_FAILURE_HOLD_MS);
          });
          if (cancelled) return;
          clearStartupUpdateFailure();
        }
      }

      // Yield once before auth so React StrictMode can dispose its development
      // probe mount without starting two concurrent session restorations when
      // automatic updates are disabled.
      await Promise.resolve();
      if (cancelled) return;
      setPhase("starting");
      try {
        await initializeAuthSession();
      } catch (error) {
        console.error("[splash] initializeAuthSession failed:", error);
      }
      if (cancelled) return;

      const startedAt = await presentedAt;
      if (cancelled) return;
      const remainingDelay = Math.max(
        0,
        SPLASH_HOLD_MS - (performance.now() - startedAt),
      );
      leaveTimer = window.setTimeout(() => {
        if (cancelled) return;
        setLeaving(true);
        doneTimer = window.setTimeout(() => {
          if (!cancelled) onDoneRef.current();
        }, SPLASH_EXIT_MS);
      }, remainingDelay);
    })();

    return () => {
      cancelled = true;
      if (failureTimer !== null) window.clearTimeout(failureTimer);
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      if (doneTimer !== null) window.clearTimeout(doneTimer);
    };
  }, [browserPreview]);

  const preview = browserPreview ? getBrowserPreviewState() : null;
  const presentation = getStartupPresentation(
    preview?.phase ?? phase,
    preview?.state ?? updateState,
  );

  return (
    <div className={`splash-root ${wide ? "splash-root--wide" : ""} ${presented ? "" : "splash-root--waiting"} ${leaving ? "splash-root--leaving" : ""}`}>
      <div className="splash-content">
        <div className="splash-brand">
        <div className="splash-shield-wrap">
          <div className="splash-glow" />
          {/* The app icon's own shield and chevrons (assets/onboarding_logo.svg),
              framed so the shield keeps the same size in the 300px box. */}
          <svg viewBox="-176 -176 2400 2400" className="splash-shield">
            <defs>
              <linearGradient
                id="shieldGradient"
                x1="549.891"
                y1="218.152"
                x2="1560.96"
                y2="1587.11"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#00deac" />
                <stop offset="1" stopColor="#0fa2ed" />
              </linearGradient>
            </defs>
            <path
              className="splash-shield-path"
              fill="url(#shieldGradient)"
              d="M1020.62 114.132c5.15-1.058 11.58 1.784 16.72 3.698 48.85 18.194 97.69 36.573 146.49 54.87l291.69 109.375 148.85 55.858c22.61 8.47 62.9 22.22 83.09 32.606 2.6 9.345 4.48 38.251 5.55 49.565 3.71 37.306 6.91 74.662 9.58 112.058 17.95 249.523 25.16 638.098-73.79 866.698-86.26 199.28-277.42 347.51-460.86 453.51a1593 1593 0 0 1-121.21 63.59c-12.68 5.92-26.86 12.9-39.78 18-6.35 3.18-43.234-16.67-51.296-20.53a1684 1684 0 0 1-85.397-43.57c-188.935-103.19-405.597-268.34-491.104-470.94-51.14-121.18-72.569-281.31-79.821-412.507-.532-12.659-2.996-26.079-3.165-38.648-.443-33.112-.164-65.467-3.572-98.502-1.354-13.131-.543-29.009-.674-42.335-.223-22.862 3.079-46.157 3.116-69.117.491-24.979.45-49.81.826-74.77.162-10.73 2.43-22.414 2.758-33.076 1.24-40.362 4.397-80.241 7.64-120.467l7.994-90.383c1.108-11.615 2.528-39.21 6.222-48.438 8.059-6.148 47.52-19.617 59.299-24.04l112.175-42.013z"
            />
            <path
              className="splash-chevron-trail"
              fill="#7ee1e5"
              d="M590.122 726.17c12.033-.873 21.129-.744 31.257 7.116 24.701 19.171 48.739 39.299 72.952 59.101l136.731 111.927 73.019 59.656c20.632 16.838 51.4 34.59 48.577 64.32a40.1 40.1 0 0 1-10.801 23.66c-8.411 9-27.246 23.53-37.496 31.86l-64.466 52.65c-71.099 58.29-143.662 119.01-215.462 176.22-10.466 7.15-20.336 11.31-33.338 9.37a43 43 0 0 1-28.656-17.84 41.21 41.21 0 0 1-6.693-32.41c2.036-9.78 4.542-14.39 11.568-21.09 15.167-14.48 32.737-27.95 49.007-41.25l89.945-73.63 88.104-72.05c12.784-10.46 36.531-31 49.305-39.27L657.674 872.397l-56.325-46.004c-11.302-9.223-23.61-18.454-33.879-28.723-25.091-25.092-11.201-63.934 22.652-71.5"
            />
            <path
              className="splash-chevron-main"
              fill="#fefefe"
              d="M824.792 618.376c3.726.264 7.433.74 11.104 1.427 11.614 2.133 19.989 6.167 29.146 13.557 19.951 16.102 39.586 33.512 59.087 50.203l118.851 101.926 148.78 127.424c15.78 13.506 76.14 62.944 85.27 76.884a63.23 63.23 0 0 1 8.31 48.593c-2.57 11.13-9.11 22.97-17.44 30.65-24.71 22.76-51.58 44.87-77.11 66.73l-151.22 129.69-120.74 103.43c-16.468 14.11-47.033 42.33-63.987 52.77-45.527 23.33-96.587-10.76-93.643-61.13 1.973-33.75 33.521-53.64 57.303-73.94l64.424-55.15 241.873-207.19c-24.35-23.17-62.11-53.521-88.32-75.985L865.073 801.251l-52.177-44.493c-22.363-18.954-47.921-35.776-51.561-67.076a61.88 61.88 0 0 1 13.329-46.088c13.53-17.028 29.239-22.964 50.128-25.218"
            />
          </svg>
        </div>

          <div className="splash-text">
            <div className="splash-title">ToBeVPN</div>
            <div className="splash-tagline">{t("splash_tagline")}</div>
          </div>
        </div>

        <div className="splash-side">
          <StartupStatusCard presentation={presentation} />
        </div>
      </div>
    </div>
  );
}

function StartupStatusCard({ presentation }: { presentation: StartupPresentation }) {
  const progressClass = [
    "startup-status-card__progress",
    presentation.indeterminate ? "startup-status-card__progress--indeterminate" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`startup-status-card startup-status-card--${presentation.tone}`}
      role="status"
      aria-live="polite"
    >
      <div className="startup-status-card__header">
        <div className="startup-status-card__icon" aria-hidden="true">
          <StartupStatusIcon icon={presentation.icon} />
        </div>
        <div className="startup-status-card__copy">
          <div className="startup-status-card__label">{presentation.label}</div>
          <div className="startup-status-card__title">{presentation.title}</div>
        </div>
      </div>

      <div className="startup-status-card__description">{presentation.description}</div>

      {presentation.showProgress && (
        <div className={progressClass}>
          <div
            className="startup-status-card__progress-fill"
            style={{ width: `${presentation.progress ?? 36}%` }}
          />
        </div>
      )}

      {(presentation.detail || presentation.percent !== undefined) && (
        <div className="startup-status-card__meta">
          <span>{presentation.detail}</span>
          {presentation.percent !== undefined && <span>{presentation.percent}%</span>}
        </div>
      )}
    </div>
  );
}

function StartupStatusIcon({ icon }: { icon: StartupIcon }) {
  if (icon === "warning") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M12 8v5" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.8 2.6 17.1A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.9L13.7 3.8a2 2 0 0 0-3.4 0Z" />
      </svg>
    );
  }

  if (icon === "check") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="m6.8 12.2 3.2 3.2 7.2-7.2" />
      </svg>
    );
  }

  if (icon === "download") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M12 4v10" />
        <path d="m8 10 4 4 4-4" />
        <path d="M5 19h14" />
      </svg>
    );
  }

  if (icon === "install") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M5 5h14v14H5z" />
        <path d="M9 12h6" />
        <path d="m12 9 3 3-3 3" />
      </svg>
    );
  }

  if (icon === "restart") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M20 11a8 8 0 1 0-2.3 5.7" />
        <path d="M20 5v6h-6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className="startup-status-card__spinner">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 8 8" />
    </svg>
  );
}

function getStartupPresentation(
  phase: StartupPhase,
  updateState: DesktopUpdateState,
): StartupPresentation {
  if (updateState.kind === "downloading") {
    const installing = updateState.progress.phase === "installing";
    const hasKnownProgress =
      !installing && updateState.progress.total > 0 && !updateState.progress.indeterminate;
    const progress = hasKnownProgress
      ? Math.min(updateState.progress.downloaded / updateState.progress.total, 1)
      : 0;
    const percent = hasKnownProgress ? Math.round(progress * 100) : undefined;
    const detail = hasKnownProgress
      ? t("startup_update_size")
          .replace("{downloaded}", formatMegabytes(updateState.progress.downloaded))
          .replace("{total}", formatMegabytes(updateState.progress.total))
      : undefined;

    return {
      tone: "active",
      icon: installing ? "install" : "download",
      label: t("startup_update_label"),
      title: t(installing ? "startup_update_installing_title" : "startup_update_title").replace(
        "{version}",
        updateState.info.version,
      ),
      description: t(
        installing ? "startup_update_installing_description" : "startup_update_description",
      ),
      showProgress: true,
      indeterminate: !hasKnownProgress,
      progress: progress * 100,
      detail,
      percent,
    };
  }

  if (updateState.kind === "available") {
    return {
      tone: "active",
      icon: "download",
      label: t("startup_update_label"),
      title: t("startup_update_title").replace("{version}", updateState.info.version),
      description: t("startup_update_preparing"),
      showProgress: true,
      indeterminate: true,
    };
  }

  if (updateState.kind === "ready" || phase === "relaunching") {
    return {
      tone: "success",
      icon: "restart",
      label: t("startup_update_label"),
      title: t("startup_update_restarting_title"),
      description: t("startup_update_restarting_description"),
      showProgress: true,
      indeterminate: true,
    };
  }

  if (updateState.kind === "failed" || phase === "failed") {
    return {
      tone: "warning",
      icon: "warning",
      label: t("startup_update_label"),
      title: t("startup_update_failed_title"),
      description: t("startup_update_failed_description"),
      showProgress: false,
      indeterminate: false,
    };
  }

  if (phase === "checking") {
    return {
      tone: "neutral",
      icon: "launch",
      label: t("startup_update_label"),
      title: t("startup_update_checking_title"),
      description: t("startup_update_checking_description"),
      showProgress: true,
      indeterminate: true,
    };
  }

  return {
    tone: "success",
    icon: "check",
    label: t("startup_launch_label"),
    title: t("startup_launch_title"),
    description: t("startup_launch_description"),
    showProgress: true,
    indeterminate: true,
  };
}

function getBrowserPreviewState(): {
  phase: StartupPhase;
  state: DesktopUpdateState;
} {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("startup") ?? "checking";
  const version = params.get("updateVersion") ?? "1.0.78";
  const info = { version, notes: "" };

  if (mode === "downloading") {
    return {
      phase: "checking",
      state: {
        kind: "downloading",
        info,
        progress: {
          downloaded: 31.8 * 1024 * 1024,
          total: 52 * 1024 * 1024,
          phase: "downloading",
        },
      },
    };
  }

  if (mode === "installing") {
    return {
      phase: "checking",
      state: {
        kind: "downloading",
        info,
        progress: { downloaded: 0, total: 0, indeterminate: true, phase: "installing" },
      },
    };
  }

  if (mode === "restarting") {
    return { phase: "relaunching", state: { kind: "ready", info } };
  }

  if (mode === "failed") {
    return {
      phase: "failed",
      state: { kind: "failed", reason: "preview", info },
    };
  }

  if (mode === "starting") {
    return { phase: "starting", state: { kind: "idle" } };
  }

  return { phase: "checking", state: { kind: "idle" } };
}

function formatMegabytes(bytes: number): string {
  return new Intl.NumberFormat(getSavedLang() === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / (1024 * 1024));
}

const SPLASH_HOLD_MS = 3200;
const SPLASH_EXIT_MS = 600;
const STARTUP_FAILURE_HOLD_MS = 1800;
