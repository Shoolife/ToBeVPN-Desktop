import type { StringKey } from "./i18n";

export interface ReleaseHighlight {
  icon: "update" | "notes";
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
      icon: "notes",
      titleKey: "whats_new_in_app_title",
      descriptionKey: "whats_new_in_app_description",
    },
  ],
};
