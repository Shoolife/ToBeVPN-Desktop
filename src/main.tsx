import React from "react";
import ReactDOM from "react-dom/client";
import App, { type Screen } from "./App";
import {
  loadRoutingSettings,
  saveRoutingSettings,
  type RoutingMode,
} from "./session/routingSettings";
// Twemoji Country Flags font is registered via @font-face in App.css so the
// flag glyphs are guaranteed available before any first paint, including
// when the WebView has no outbound network yet (jsDelivr is unreachable
// before the VPN tunnel is up).

const browserPreview =
  import.meta.env.DEV &&
  !("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const requestedPreviewScreen = browserPreview
  ? new URLSearchParams(window.location.search).get("screen")
  : null;
const requestedRoutingMode = browserPreview
  ? new URLSearchParams(window.location.search).get("routing")
  : null;
const routingModes = new Set<RoutingMode>(["blocked_only", "selective", "all_vpn"]);
if (requestedRoutingMode && routingModes.has(requestedRoutingMode as RoutingMode)) {
  saveRoutingSettings({
    ...loadRoutingSettings(),
    mode: requestedRoutingMode as RoutingMode,
  });
}
const previewScreens = new Set<Screen>(["home", "settings", "routing"]);
const initialScreen: Screen =
  requestedPreviewScreen && previewScreens.has(requestedPreviewScreen as Screen)
    ? (requestedPreviewScreen as Screen)
    : browserPreview
      ? "home"
      : "splash";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App
      initialScreen={initialScreen}
      browserPreview={browserPreview}
    />
  </React.StrictMode>,
);
