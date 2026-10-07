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
      icon: "schedule",
      titleKey: "whats_new_traffic_reset_title",
      descriptionKey: "whats_new_traffic_reset_description",
    },
    {
      icon: "checkCircle",
      titleKey: "whats_new_server_selection_title",
      descriptionKey: "whats_new_server_selection_description",
    },
    {
      icon: "info",
      titleKey: "whats_new_clear_errors_title",
      descriptionKey: "whats_new_clear_errors_description",
    },
    {
      icon: "public",
      titleKey: "whats_new_windows_dns_title",
      descriptionKey: "whats_new_windows_dns_description",
    },
    {
      icon: "refresh",
      titleKey: "whats_new_faster_updates_title",
      descriptionKey: "whats_new_faster_updates_description",
    },
  ],
};
