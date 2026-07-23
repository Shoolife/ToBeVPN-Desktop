import React from "react";
import ReactDOM from "react-dom/client";
import App, { type Screen } from "./App";
import BrowserServersPreview from "./components/BrowserServersPreview";
import {
  loadRoutingSettings,
  saveRoutingSettings,
  type RoutingMode,
} from "./session/routingSettings";
import { seedVpnServersForBrowserPreview, type VpnServer } from "./session/auth";
import { isBrowserPreviewRuntime } from "./session/browserPreview";
import { updateSession } from "./session/store";
import { applyTheme, type ThemeMode } from "./session/theme";
import { saveLang } from "./i18n";
// Twemoji Country Flags font is registered via @font-face in App.css so the
// flag glyphs are guaranteed available before any first paint, including
// when the WebView has no outbound network yet (jsDelivr is unreachable
// before the VPN tunnel is up).

const browserPreview = isBrowserPreviewRuntime();
const searchParams = browserPreview
  ? new URLSearchParams(window.location.search)
  : null;
const requestedPreviewScreen = browserPreview
  ? searchParams?.get("screen")
  : null;
const requestedRoutingMode = browserPreview
  ? searchParams?.get("routing")
  : null;
const requestedTheme = browserPreview ? searchParams?.get("theme") : null;
const requestedLanguage = browserPreview ? searchParams?.get("lang") : null;
const previewTheme: ThemeMode | null =
  requestedTheme === "light" || requestedTheme === "dark"
    ? requestedTheme
    : null;
const compareServersPreview =
  browserPreview &&
  requestedPreviewScreen === "servers" &&
  searchParams?.get("compare") === "1";
const adminPreview = browserPreview ? searchParams?.get("admin") !== "0" : false;
applyTheme(previewTheme ?? undefined);
if (requestedLanguage === "ru" || requestedLanguage === "en") {
  saveLang(requestedLanguage);
}
const routingModes = new Set<RoutingMode>(["blocked_only", "selective", "all_vpn"]);
if (requestedRoutingMode && routingModes.has(requestedRoutingMode as RoutingMode)) {
  saveRoutingSettings({
    ...loadRoutingSettings(),
    mode: requestedRoutingMode as RoutingMode,
  });
}
const previewScreens = new Set<Screen>([
  "splash",
  "home",
  "settings",
  "servers",
  "routing",
  "referrals",
]);
const initialScreen: Screen =
  requestedPreviewScreen && previewScreens.has(requestedPreviewScreen as Screen)
    ? (requestedPreviewScreen as Screen)
    : browserPreview
      ? "home"
      : "splash";

const BROWSER_PREVIEW_SHORT_UUID = "browser-preview";

const browserPreviewServers: VpnServer[] = [
  {
    id: "preview-nl-1",
    name: "Нидерланды 1",
    address: "nl-1.preview.tobevpn.net",
    port: 443,
    uuid: "11111111-1111-4111-8111-111111111111",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: "www.microsoft.com",
    fingerprint: "chrome",
    public_key: "preview-public-key-1",
    short_id: "a1b2c3d4",
    network: "tcp",
    path: "",
    mode: "",
    spx: "",
    country: "NL",
    isOnline: true,
    sortOrder: 0,
  },
  {
    id: "preview-de-1",
    name: "Германия 1",
    address: "de-1.preview.tobevpn.net",
    port: 443,
    uuid: "22222222-2222-4222-8222-222222222222",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: "www.microsoft.com",
    fingerprint: "chrome",
    public_key: "preview-public-key-2",
    short_id: "b2c3d4e5",
    network: "tcp",
    path: "",
    mode: "",
    spx: "",
    country: "DE",
    isOnline: true,
    sortOrder: 1,
  },
  {
    id: "preview-nl-2",
    name: "Нидерланды 2",
    address: "nl-2.preview.tobevpn.net",
    port: 8443,
    uuid: "33333333-3333-4333-8333-333333333333",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: "www.microsoft.com",
    fingerprint: "chrome",
    public_key: "preview-public-key-3",
    short_id: "c3d4e5f6",
    network: "tcp",
    path: "",
    mode: "",
    spx: "",
    country: "NL",
    isOnline: true,
    sortOrder: 2,
  },
  {
    id: "preview-nl-4",
    name: "Нидерланды 4",
    address: "nl-4-long-domain.preview.tobevpn.net",
    port: 9443,
    uuid: "44444444-4444-4444-8444-444444444444",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: "www.microsoft.com",
    fingerprint: "chrome",
    public_key: "preview-public-key-4",
    short_id: "d4e5f6a7",
    network: "tcp",
    path: "",
    mode: "",
    spx: "",
    country: "NL",
    isOnline: true,
    sortOrder: 3,
  },
];

if (browserPreview) {
  updateSession({
    isLinked: true,
    telegramId: 100000001,
    shortUuid: BROWSER_PREVIEW_SHORT_UUID,
    panelUserUuid: "browser-preview-panel-user",
    userPlan: "ADMIN",
    planDisplayName: "Admin",
    planExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    isAdminProfile: adminPreview,
    trafficLimitBytes: 100 * 1024 * 1024 * 1024,
    trafficUsedBytes: 24 * 1024 * 1024 * 1024,
    email: "preview@tobevpn.local",
  });
  seedVpnServersForBrowserPreview(BROWSER_PREVIEW_SHORT_UUID, browserPreviewServers);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {compareServersPreview ? (
      <BrowserServersPreview servers={browserPreviewServers} />
    ) : (
      <App
        initialScreen={initialScreen}
        browserPreview={browserPreview}
      />
    )}
  </React.StrictMode>,
);
