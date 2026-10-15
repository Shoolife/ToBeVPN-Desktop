import type { StringKey } from "./i18n";
import type { MaterialIconName } from "./components/MaterialIcon";

export interface ReleaseHighlight {
  icon: MaterialIconName;
  titleKey: StringKey;
  descriptionKey: StringKey;
}

export interface ReleaseNotesEntry {
  version: string;
  highlights: readonly ReleaseHighlight[];
}

// Keep release copy separate from the dialog layout. "What's new" intentionally
// describes only the currently installed version, without a release archive.
export const CURRENT_RELEASE_NOTES: ReleaseNotesEntry = {
  version: __APP_VERSION__,
  highlights: [
    {
      icon: "public",
      titleKey: "whats_new_panel_ready_title",
      descriptionKey: "whats_new_panel_ready_description",
    },
    {
      icon: "percent",
      titleKey: "whats_new_clear_discounts_title",
      descriptionKey: "whats_new_clear_discounts_description",
    },
    {
      icon: "bolt",
      titleKey: "whats_new_faster_server_check_title",
      descriptionKey: "whats_new_faster_server_check_description",
    },
    {
      icon: "dataUsage",
      titleKey: "whats_new_live_usage_title",
      descriptionKey: "whats_new_live_usage_description",
    },
    {
      icon: "security",
      titleKey: "whats_new_xray_core_title",
      descriptionKey: "whats_new_xray_core_description",
    },
  ],
};
