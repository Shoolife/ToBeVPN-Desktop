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
      icon: "router",
      titleKey: "whats_new_pause_home_title",
      descriptionKey: "whats_new_pause_home_description",
    },
    {
      icon: "altRoute",
      titleKey: "whats_new_ip_exceptions_title",
      descriptionKey: "whats_new_ip_exceptions_description",
    },
    {
      icon: "dataUsage",
      titleKey: "whats_new_stats_click_title",
      descriptionKey: "whats_new_stats_click_description",
    },
    {
      icon: "devices",
      titleKey: "whats_new_keenetic_title",
      descriptionKey: "whats_new_keenetic_description",
    },
    {
      icon: "autoAwesome",
      titleKey: "whats_new_calm_numbers_title",
      descriptionKey: "whats_new_calm_numbers_description",
    },
  ],
};
