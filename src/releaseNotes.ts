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
      icon: "bolt",
      titleKey: "whats_new_hysteria2_title",
      descriptionKey: "whats_new_hysteria2_description",
    },
    {
      icon: "person",
      titleKey: "whats_new_stay_signed_in_title",
      descriptionKey: "whats_new_stay_signed_in_description",
    },
    {
      icon: "contentCopy",
      titleKey: "whats_new_copy_address_title",
      descriptionKey: "whats_new_copy_address_description",
    },
    {
      icon: "settingsBackupRestore",
      titleKey: "whats_new_transfer_timeout_title",
      descriptionKey: "whats_new_transfer_timeout_description",
    },
    {
      icon: "schedule",
      titleKey: "whats_new_referrer_limit_title",
      descriptionKey: "whats_new_referrer_limit_description",
    },
    {
      icon: "security",
      titleKey: "whats_new_xray_core_title",
      descriptionKey: "whats_new_xray_core_description",
    },
  ],
};
