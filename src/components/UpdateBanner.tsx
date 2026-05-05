// In-app updater banner. Mirrors the Android equivalents — same four phases,
// same UX strings, same behavior — but driven by tauri-plugin-updater so the
// install step is silent (Windows NSIS /UPDATE) or single-prompt (Linux pkexec
// dpkg) instead of routing the user to the system package installer dialog.
//
// All state is owned by `updateStore` (the desktop equivalent of the Android
// UpdateViewModel). This component is a pure presentation layer — it
// subscribes to the shared store, so dismissing here also flips the
// "Available" row in Settings to "На последней версии", and clicking
// "Проверить" in Settings re-surfaces this banner.

import { useEffect } from "react";
import { t } from "../i18n";
import {
  dismissUpdate,
  ensureInitialCheck,
  retryUpdate,
  startUpdateDownload,
  useUpdateState,
  type DesktopUpdateInfo,
  type DesktopUpdateProgress,
} from "../session/updateStore";
import "./UpdateBanner.css";

export default function UpdateBanner() {
  const state = useUpdateState();

  useEffect(() => {
    void ensureInitialCheck();
  }, []);

  if (state.kind === "idle") return null;

  return (
    <div className="update-banner">
      {state.kind === "available" && (
        <Available
          info={state.info}
          onDownload={() => void startUpdateDownload()}
          onDismiss={dismissUpdate}
        />
      )}
      {state.kind === "downloading" && (
        <Downloading info={state.info} progress={state.progress} />
      )}
      {state.kind === "ready" && <Ready info={state.info} />}
      {state.kind === "failed" && (
        <Failed reason={state.reason} onRetry={retryUpdate} onDismiss={dismissUpdate} />
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
