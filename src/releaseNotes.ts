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
      titleKey: "whats_new_faster_connect_title",
      descriptionKey: "whats_new_faster_connect_description",
    },
    {
      icon: "refresh",
      titleKey: "whats_new_faster_recovery_title",
      descriptionKey: "whats_new_faster_recovery_description",
    },
    {
      icon: "dns",
      titleKey: "whats_new_servers_kept_title",
      descriptionKey: "whats_new_servers_kept_description",
    },
    {
      icon: "router",
      titleKey: "whats_new_router_servers_pc_title",
      descriptionKey: "whats_new_router_servers_pc_description",
    },
    {
      icon: "public",
      titleKey: "whats_new_ru_sites_pc_title",
      descriptionKey: "whats_new_ru_sites_pc_description",
    },
    {
      icon: "autoAwesome",
      titleKey: "whats_new_components_title",
      descriptionKey: "whats_new_components_description",
    },
  ],
};
