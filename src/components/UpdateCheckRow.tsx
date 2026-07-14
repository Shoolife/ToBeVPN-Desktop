// Settings → About → "Check for updates" row.
//
// Mirrors the Android phone/TV equivalent. Tapping the button bypasses the
// 7-day cache (and any pending dismissal) and forces a fresh GitHub probe
// via the shared updateStore. The store is the same source of truth used
// by the home/overlay UpdateBanner, so a forced check here re-surfaces the
// banner across every screen.

import { t } from "../i18n";
import {
  forceCheckUpdate,
  useManualCheckInFlight,
  useUpdateState,
} from "../session/updateStore";
import "./UpdateCheckRow.css";

export default function UpdateCheckRow({ onWhatsNew }: { onWhatsNew: () => void }) {
  const state = useUpdateState();
  const checking = useManualCheckInFlight();
  const updateBusy = state.kind === "downloading" || state.kind === "ready";

  // "Available" is the only state that should override the default
  // "На последней версии {current}" message — once the user dismisses
  // (state → idle) we want the row to flip back to up-to-date even
  // though the cache still remembers v1.0.5 in the background.
  const status =
    state.kind === "available"
      ? t("update_available_short")
          .replace("{current}", __APP_VERSION__)
          .replace("{version}", state.info.version)
      : t("update_check_uptodate").replace("{version}", __APP_VERSION__);

  const onClick = () => {
    if (checking || updateBusy) return;
    void forceCheckUpdate();
  };

  return (
    <div className="settings-info-row update-check-row">
      <button
        type="button"
        className="update-check-row__version"
        onClick={onWhatsNew}
        aria-label={`${status}. ${t("about_whats_new_current")}`}
      >
        <span className="settings-info-row__label settings-info-row__label--muted">
          {status}
        </span>
        <span className="update-check-row__whats-new">
          {t("about_whats_new_current")}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        className="update-check-row__btn"
        onClick={onClick}
        disabled={checking || updateBusy}
      >
        {checking ? t("update_check_button_loading") : t("update_check_button")}
      </button>
    </div>
  );
}
