// In-app updater banner. Mirrors the Android equivalents — same four phases,
// same UX strings, same behavior — but driven by tauri-plugin-updater so the
// install step is silent (Windows NSIS /UPDATE) or single-prompt (Linux pkexec
// dpkg) instead of routing the user to the system package installer dialog.

import { useEffect, useState } from "react";
import { t } from "../i18n";
import {
  checkForUpdate,
  downloadAndInstall,
  type DesktopUpdateInfo,
  type DesktopUpdateProgress,
  type DesktopUpdateState,
} from "../session/desktopUpdater";
import "./UpdateBanner.css";

export default function UpdateBanner() {
  const [state, setState] = useState<DesktopUpdateState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await checkForUpdate();
      if (cancelled || !info) return;
      setState({ kind: "available", info });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDownload = async () => {
    if (state.kind !== "available") return;
    const info = state.info;
    setState({ kind: "downloading", info, progress: { downloaded: 0, total: 0 } });
    try {
      await downloadAndInstall((progress: DesktopUpdateProgress) => {
        setState((current) =>
          current.kind === "downloading"
            ? { kind: "downloading", info: current.info, progress }
            : current,
        );
      });
      // After downloadAndInstall the relaunch happens inside the plugin; the
      // UI is going down anyway, but flip to ready as a no-op safety in case
      // the plugin returns without restarting (e.g., user denies UAC).
      setState({ kind: "ready", info });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setState({ kind: "failed", reason });
    }
  };

  const dismiss = () => setState({ kind: "idle" });
  const retry = () => {
    void (async () => {
      const info = await checkForUpdate();
      if (info) setState({ kind: "available", info });
      else setState({ kind: "idle" });
    })();
  };

  if (state.kind === "idle") return null;

  return (
    <div className="update-banner">
      {state.kind === "available" && (
        <Available info={state.info} onDownload={handleDownload} onDismiss={dismiss} />
      )}
      {state.kind === "downloading" && (
        <Downloading info={state.info} progress={state.progress} />
      )}
      {state.kind === "ready" && <Ready info={state.info} />}
      {state.kind === "failed" && (
        <Failed reason={state.reason} onRetry={retry} onDismiss={dismiss} />
      )}
    </div>
  );
}

function Available({
  info,
  onDownload,
  onDismiss,
}: {
  info: DesktopUpdateInfo;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  // Compact one-row layout. We deliberately skip GitHub's release notes
  // here — the auto-generated body for tag-only releases is a noisy
  // "Full Changelog: <url>" string and pads the banner to half the
  // screen.
  return (
    <div className="update-banner__row">
      <div className="update-banner__title">
        {t("update_banner_title").replace("{version}", info.version)}
      </div>
      <div className="update-banner__actions">
        <button className="update-banner__btn-text" onClick={onDismiss}>
          {t("update_banner_later")}
        </button>
        <button className="update-banner__btn-primary" onClick={onDownload}>
          {t("update_banner_download")}
        </button>
      </div>
    </div>
  );
}

function Downloading({
  info,
  progress,
}: {
  info: DesktopUpdateInfo;
  progress: DesktopUpdateProgress;
}) {
  const fraction =
    progress.total > 0 ? Math.min(progress.downloaded / progress.total, 1) : 0;
  const downloadedMb = (progress.downloaded / (1024 * 1024)).toFixed(1);
  const totalMb = progress.total > 0 ? (progress.total / (1024 * 1024)).toFixed(1) : null;
  return (
    <>
      <div className="update-banner__title">
        {t("update_banner_downloading_title").replace("{version}", info.version)}
      </div>
      <div className="update-banner__progress">
        <div
          className="update-banner__progress-fill"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <div className="update-banner__progress-text">
        {totalMb ? `${downloadedMb} МБ / ${totalMb} МБ` : `${downloadedMb} МБ`}
      </div>
    </>
  );
}

function Ready({ info }: { info: DesktopUpdateInfo }) {
  return (
    <>
      <div className="update-banner__title">
        {t("update_banner_ready_title").replace("{version}", info.version)}
      </div>
      <div className="update-banner__notes">
        {t("update_banner_ready_description")}
      </div>
    </>
  );
}

function Failed({
  reason,
  onRetry,
  onDismiss,
}: {
  reason: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <div className="update-banner__title update-banner__title--error">
        {t("update_banner_failed_title")}
      </div>
      {reason && <div className="update-banner__notes">{reason.slice(0, 200)}</div>}
      <div className="update-banner__actions">
        <button className="update-banner__btn-text" onClick={onDismiss}>
          {t("update_banner_later")}
        </button>
        <button className="update-banner__btn-primary" onClick={onRetry}>
          {t("update_banner_retry")}
        </button>
      </div>
    </>
  );
}
