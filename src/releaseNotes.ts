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
      icon: "autoAwesome",
      titleKey: "whats_new_desktop_scale_title",
      descriptionKey: "whats_new_desktop_scale_description",
    },
    {
      icon: "refresh",
      titleKey: "whats_new_resume_recovery_title",
      descriptionKey: "whats_new_resume_recovery_description",
    },
    {
      icon: "dataUsage",
      titleKey: "whats_new_data_reliability_title",
      descriptionKey: "whats_new_data_reliability_description",
    },
    {
      icon: "bugReportOutlined",
      titleKey: "whats_new_diagnostics_export_title",
      descriptionKey: "whats_new_diagnostics_export_description",
    },
    {
      icon: "arrowBack",
      titleKey: "whats_new_navigation_title",
      descriptionKey: "whats_new_navigation_description",
    },
  ],
};
