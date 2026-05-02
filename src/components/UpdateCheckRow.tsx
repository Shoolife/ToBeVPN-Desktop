// Settings → About → "Check for updates" row.
//
// Mirrors the Android phone/TV equivalent. Tapping the button bypasses the
// 7-day cache and forces a fresh GitHub probe via the Tauri Updater plugin.
// The actual update banner lives on the Home screen — here we only surface
// inline status so the user gets feedback without leaving Settings.

import { useEffect, useState } from "react";
import { t } from "../i18n";
import { checkForUpdate, type DesktopUpdateInfo } from "../session/desktopUpdater";
import "./UpdateCheckRow.css";

export default function UpdateCheckRow() {
  const [info, setInfo] = useState<DesktopUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);

  // On mount we read the cache (no-network call). The Home banner has
  // already done a real probe at app startup, so this is just a display
  // refresh — won't burn the GitHub rate limit.
  useEffect(() => {
    let cancelled = false;
    void checkForUpdate(false).then((result) => {
      if (!cancelled) setInfo(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const result = await checkForUpdate(true);
      setInfo(result);
    } finally {
      setChecking(false);
    }
  };

  const status = info
    ? t("update_available_short").replace("{version}", info.version)
    : t("update_check_uptodate").replace("{version}", __APP_VERSION__);

  return (
    <div className="settings-info-row update-check-row">
      <span className="settings-info-row__label settings-info-row__label--muted">
        {status}
      </span>
      <button
        className="update-check-row__btn"
        onClick={handleCheck}
        disabled={checking}
      >
        {checking ? t("update_check_button_loading") : t("update_check_button")}
      </button>
    </div>
  );
}
