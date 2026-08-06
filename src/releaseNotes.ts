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
      icon: "cardGiftcard",
      titleKey: "whats_new_promocodes_title",
      descriptionKey: "whats_new_promocodes_description",
    },
    {
      icon: "info",
      titleKey: "whats_new_diagnostics_title",
      descriptionKey: "whats_new_diagnostics_description",
    },
    {
      icon: "autoAwesome",
      titleKey: "whats_new_connection_title",
      descriptionKey: "whats_new_connection_description",
    },
    {
      icon: "refresh",
      titleKey: "whats_new_xray_title",
      descriptionKey: "whats_new_xray_description",
    },
  ],
};
