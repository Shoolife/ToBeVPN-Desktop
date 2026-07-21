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
}: {
  onDone: () => void;
  browserPreview?: boolean;
}) {
  const onDoneRef = useRef(onDone);
  const updateState = useUpdateState();
  const [phase, setPhase] = useState<StartupPhase>(() =>
    !browserPreview && getAutoUpdateEnabled() ? "checking" : "starting",
  );
  const [leaving, setLeaving] = useState(false);

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
      const startedAt = performance.now();

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
    <div className={`splash-root ${leaving ? "splash-root--leaving" : ""}`}>
      <div className="splash-content">
        <div className="splash-shield-wrap">
          <div className="splash-glow" />
          <svg viewBox="0 0 100 100" className="splash-shield">
            <defs>
              <linearGradient
                id="shieldGradient"
                x1="22%"
                y1="12%"
                x2="78%"
                y2="88%"
              >
                <stop offset="0%" stopColor="#00E5A0" />
                <stop offset="50%" stopColor="#00BCD4" />
                <stop offset="100%" stopColor="#2196F3" />
              </linearGradient>
            </defs>
            <path
              className="splash-shield-path"
              d="M50,12 C55,12 78,18 78,22 C78,50 72,68 50,88 C28,68 22,50 22,22 C22,18 45,12 50,12 Z"
              stroke="url(#shieldGradient)"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="splash-chevron-trail"
              d="M34,41 L46,50 L34,59"
              stroke="#FFFFFF"
              strokeOpacity="0.4"
              strokeWidth="1.35"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="splash-chevron-main"
              d="M44,38 L60,50 L44,62"
              stroke="#FFFFFF"
              strokeWidth="1.9"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="splash-text">
          <div className="splash-title">ToBeVPN</div>
          <div className="splash-tagline">{t("splash_tagline")}</div>
        </div>

        <StartupStatusCard presentation={presentation} />
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
  const version = params.get("updateVersion") ?? "1.0.77";
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

const SPLASH_HOLD_MS = 1600;
const SPLASH_EXIT_MS = 400;
const STARTUP_FAILURE_HOLD_MS = 1800;
