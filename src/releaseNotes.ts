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
      icon: "refresh",
      titleKey: "whats_new_resume_title",
      descriptionKey: "whats_new_resume_description",
    },
    {
      icon: "bolt",
      titleKey: "whats_new_quick_ping_title",
      descriptionKey: "whats_new_quick_ping_description",
    },
    {
      icon: "altRoute",
      titleKey: "whats_new_final_mask_title",
      descriptionKey: "whats_new_final_mask_description",
    },
    {
      icon: "security",
      titleKey: "whats_new_xray_core_title",
      descriptionKey: "whats_new_xray_core_description",
    },
  ],
};
