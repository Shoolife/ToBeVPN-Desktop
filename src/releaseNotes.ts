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
      titleKey: "whats_new_router_vpn_title",
      descriptionKey: "whats_new_router_vpn_description",
    },
    {
      icon: "devices",
      titleKey: "whats_new_several_routers_title",
      descriptionKey: "whats_new_several_routers_description",
    },
    {
      icon: "dataUsage",
      titleKey: "whats_new_router_traffic_title",
      descriptionKey: "whats_new_router_traffic_description",
    },
    {
      icon: "bolt",
      titleKey: "whats_new_router_speed_test_title",
      descriptionKey: "whats_new_router_speed_test_description",
    },
    {
      icon: "autoAwesome",
      titleKey: "whats_new_smoother_ui_title",
      descriptionKey: "whats_new_smoother_ui_description",
    },
    {
      icon: "dns",
      titleKey: "whats_new_linux_distros_title",
      descriptionKey: "whats_new_linux_distros_description",
    },
    {
      icon: "security",
      titleKey: "whats_new_xray_core_title",
      descriptionKey: "whats_new_xray_core_description",
    },
  ],
};
