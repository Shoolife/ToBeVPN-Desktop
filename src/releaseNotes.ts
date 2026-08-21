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
      icon: "link",
      titleKey: "whats_new_telegram_payment_title",
      descriptionKey: "whats_new_telegram_payment_description",
    },
    {
      icon: "autoAwesome",
      titleKey: "whats_new_clean_ui_title",
      descriptionKey: "whats_new_clean_ui_description",
    },
  ],
};
