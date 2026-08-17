import { useState, useRef, useEffect, useLayoutEffect, useCallback, useSyncExternalStore, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalSize, primaryMonitor } from "@tauri-apps/api/window";
import SplashScreen from "./screens/SplashScreen";
import OnboardingScreen from "./screens/OnboardingScreen";
import PairingScreen from "./screens/PairingScreen";
import HomeScreen from "./screens/HomeScreen";
import SettingsScreen, { type SettingsSection } from "./screens/SettingsScreen";
import ServersScreen from "./screens/ServersScreen";
import StatsScreen from "./screens/StatsScreen";
import SpeedTestScreen from "./screens/SpeedTestScreen";
import DevicesScreen from "./screens/DevicesScreen";
import RoutingScreen from "./screens/RoutingScreen";
import ReferralsScreen from "./screens/ReferralsScreen";
import PromocodesScreen from "./screens/PromocodesScreen";
import AppErrorBoundary from "./components/AppErrorBoundary";
import UpdateBanner from "./components/UpdateBanner";
import brandLogo from "./assets/onboarding_logo.svg";
import {
  getCachedVpnServers,
  getUpdateRequired,
  isAvailableVpnServer,
  subscribeSubscriptionUsageBlocked,
  subscribeVpnServers,
  type VpnServer,
} from "./session/auth";
import { isPaired, useSession } from "./session/store";
import { startDeviceLinkPolling, stopDeviceLinkPolling } from "./session/auth";
import { hasSameVpnConfig, isSameServerSelection } from "./session/serverSelection";
import { connectVpn, disconnectVpn, getVpnRuntime } from "./session/vpnState";
import {
  launchedFromAutostart,
  listenForAutostartConnect,
} from "./session/autostart";
import {
  clearLastServer,
  clearSelectedServer,
  loadAutomaticServerSelection,
  loadLastServer,
  saveAutomaticServerSelection,
  saveLastServer,
  subscribeServerSelection,
} from "./session/lastServer";
import { selectBestVpnServer } from "./session/serverQuality";
import {
  initializeDiagnostics,
  recordDiagnosticEvent,
} from "./session/diagnostics";
import {
  DESIGN_WINDOW_HEIGHT,
  DESIGN_WINDOW_WIDTH,
  getSavedBoldText,
  getSavedFontScale,
  getSavedInterfaceScale,
  getSavedOutlinedText,
  interfaceScaleToWindowScale,
  INTERFACE_SCALE_MAX,
  INTERFACE_SCALE_MIN,
  saveBoldText,
  saveFontScale,
  saveInterfaceScale,
  saveOutlinedText,
  WINDOW_RENDER_SCALE_MAX,
  WINDOW_RENDER_SCALE_MIN,
  WINDOW_SCALE_BASE,
} from "./session/interfaceScale";
import "./App.css";

export type Screen = "splash" | "onboarding" | "pairing" | "home" | "settings" | "servers" | "stats" | "speedtest" | "devices" | "routing" | "referrals" | "promocodes";

const ONBOARDING_SEEN_KEY = "tobevpn_onboarding_seen_v1";

function shouldUseWindowsFrame(browserPreview: boolean): boolean {
  return !browserPreview && navigator.userAgent.includes("Windows");
}

function WindowsTitleBar() {
  const appWindow = getCurrentWindow();

  const startWindowDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    void appWindow.startDragging();
  };

  return (
    <div
      className="windows-titlebar"
      data-tauri-drag-region
      onPointerDown={startWindowDrag}
    >
      <div className="windows-titlebar__brand" data-tauri-drag-region>
        <img src={brandLogo} alt="" className="windows-titlebar__icon" draggable={false} />
        <span data-tauri-drag-region>ToBeVPN</span>
      </div>
      <div className="windows-titlebar__controls">
        <button
          type="button"
          className="windows-titlebar__button"
          aria-label="Свернуть"
          onClick={() => void appWindow.minimize()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="windows-titlebar__button windows-titlebar__button--close"
          aria-label="Закрыть"
          onClick={() => {
            void invoke("hide_main_window_to_tray").catch(() => appWindow.close());
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markOnboardingSeen(): void {
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // Unavailable storage only means onboarding may be shown again next start.
  }
}

function toSelectedServer(server: VpnServer): SelectedServer {
  return {
    name: server.name,
    country: server.country,
    address: server.address,
    port: server.port,
    uuid: server.uuid,
    flow: server.flow,
    security: server.security,
    sni: server.sni,
    fingerprint: server.fingerprint,
    public_key: server.public_key,
    short_id: server.short_id,
    network: server.network,
    path: server.path,
    mode: server.mode,
    spx: server.spx,
  };
}

export interface SelectedServer {
  name: string;
  country: string;
  address: string;
  port: number;
  uuid: string;
  flow: string;
  security: string;
  sni: string;
  fingerprint: string;
  public_key: string;
  short_id: string;
  network: string;
  path: string;
  mode: string;
  spx: string;
}

type Direction = "forward" | "backward" | "none";

type InterfaceScaleRequest = {
  value: number;
  centerAfterResize: boolean;
  revision: number;
};

export default function App({
  initialScreen = "splash",
  browserPreview = false,
}: {
  initialScreen?: Screen;
  browserPreview?: boolean;
}) {
  const [currentScreen, setCurrentScreen] = useState<Screen>(initialScreen);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("main");
  const startupComplete = currentScreen !== "splash";
  const [prevScreen, setPrevScreen] = useState<Screen | null>(null);
  const [direction, setDirection] = useState<Direction>("none");
  const [animating, setAnimating] = useState(false);
  const [selectedServer, setSelectedServer] = useState<SelectedServer | null>(() => loadLastServer());
  const [automaticServerSelection, setAutomaticServerSelection] = useState(
    () => loadAutomaticServerSelection(),
  );
  const selectedServerRef = useRef<SelectedServer | null>(selectedServer);
  const automaticServerSelectionRef = useRef(automaticServerSelection);
  const [autostartConnectRequested, setAutostartConnectRequested] = useState(false);
  const initialAutostartRequestQueuedRef = useRef(false);
  const updateRequired = useSyncExternalStore(
    subscribeSubscriptionUsageBlocked,
    getUpdateRequired,
    getUpdateRequired,
  );
  const [interfaceScaleRequest, setInterfaceScaleRequest] = useState<InterfaceScaleRequest>(
    () => ({
      value: getSavedInterfaceScale(),
      centerAfterResize: true,
      revision: 0,
    }),
  );
  const [fontScale, setFontScale] = useState(getSavedFontScale);
  const [boldText, setBoldText] = useState(getSavedBoldText);
  const [outlinedText, setOutlinedText] = useState(getSavedOutlinedText);
  const interfaceScaleResizeGenerationRef = useRef(0);
  const renderedFontScaleRef = useRef(fontScale);
  const fontScaleFrameRef = useRef<number | null>(null);
  const fontScaleInitializedRef = useRef(false);
  const useWindowsFrame = shouldUseWindowsFrame(browserPreview);
  const timeoutRef = useRef<number | null>(null);

  const DURATION = 300;

  const requestInterfaceScale = useCallback((value: number, centerAfterResize = false) => {
    const normalized = saveInterfaceScale(value);
    setInterfaceScaleRequest((current) => ({
      value: normalized,
      centerAfterResize,
      revision: current.revision + 1,
    }));
  }, []);

  const requestFontScale = useCallback((value: number) => {
    setFontScale(saveFontScale(value));
  }, []);

  const requestBoldText = useCallback((value: boolean) => {
    setBoldText(saveBoldText(value));
  }, []);

  const requestOutlinedText = useCallback((value: boolean) => {
    setOutlinedText(saveOutlinedText(value));
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--app-font-weight-boost", boldText ? "300" : "0");
    root.dataset.appOutlinedText = outlinedText ? "true" : "false";
  }, [boldText, outlinedText]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (fontScaleFrameRef.current !== null) {
      window.cancelAnimationFrame(fontScaleFrameRef.current);
      fontScaleFrameRef.current = null;
    }
    if (!fontScaleInitializedRef.current) {
      fontScaleInitializedRef.current = true;
      renderedFontScaleRef.current = fontScale;
      root.style.setProperty("--app-font-scale", String(fontScale));
      return;
    }

    const from = renderedFontScaleRef.current;
    const to = fontScale;
    if (Math.abs(to - from) < 0.0001) return;
    const startedAt = window.performance.now();
    const durationMs = 210;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      const value = from + (to - from) * eased;
      renderedFontScaleRef.current = value;
      root.style.setProperty("--app-font-scale", String(value));
      if (progress < 1) {
        fontScaleFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        fontScaleFrameRef.current = null;
      }
    };
    fontScaleFrameRef.current = window.requestAnimationFrame(animate);

    return () => {
      if (fontScaleFrameRef.current !== null) {
        window.cancelAnimationFrame(fontScaleFrameRef.current);
        fontScaleFrameRef.current = null;
      }
    };
  }, [fontScale]);

  useEffect(() => {
    if (useWindowsFrame) document.documentElement.dataset.windowFrame = "windows";
    else delete document.documentElement.dataset.windowFrame;
  }, [useWindowsFrame]);

  useEffect(() => {
    if (browserPreview) return;
    void initializeDiagnostics()
      .then(() => recordDiagnosticEvent("App", "Desktop user interface initialized"))
      .catch(() => {});
    const onOnline = () => recordDiagnosticEvent("Network", "Operating system reports network online");
    const onOffline = () => recordDiagnosticEvent("Network", "Operating system reports network offline", "W");
    const onVisibility = () => recordDiagnosticEvent(
      "App",
      `User interface visibility changed to ${document.visibilityState}`,
      "D",
    );
    const onUnhandledError = (event: ErrorEvent) => recordDiagnosticEvent(
      "App-Error",
      `Unhandled user interface error: ${event.message || "unknown error"}`,
      "E",
    );
    const onUnhandledRejection = (event: PromiseRejectionEvent) => recordDiagnosticEvent(
      "App-Error",
      `Unhandled asynchronous error: ${String(event.reason)}`,
      "E",
    );
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("error", onUnhandledError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("error", onUnhandledError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [browserPreview]);

  useEffect(() => {
    if (browserPreview) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listenForAutostartConnect(() => {
      if (!cancelled) setAutostartConnectRequested(true);
    })
      .then((stopListening) => {
        if (cancelled) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => console.error("Could not listen for autostart requests", error));

    void launchedFromAutostart()
      .then((launched) => {
        if (
          !cancelled &&
          launched &&
          !initialAutostartRequestQueuedRef.current
        ) {
          initialAutostartRequestQueuedRef.current = true;
          setAutostartConnectRequested(true);
        }
      })
      .catch((error) => console.error("Could not read launch context", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [browserPreview]);

  const navigate = useCallback((to: Screen, dir: Direction) => {
    if (animating) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setPrevScreen(currentScreen);
    setDirection(dir);
    setCurrentScreen(to);
    setAnimating(true);
    timeoutRef.current = window.setTimeout(() => {
      setPrevScreen(null);
      setDirection("none");
      setAnimating(false);
    }, DURATION);
  }, [currentScreen, animating]);

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []);

  useEffect(() => {
    selectedServerRef.current = selectedServer;
  }, [selectedServer]);

  useEffect(() => {
    automaticServerSelectionRef.current = automaticServerSelection;
  }, [automaticServerSelection]);

  useEffect(() => {
    return subscribeServerSelection(() => {
      const loadedServer = loadLastServer();
      const automatic = loadAutomaticServerSelection();
      selectedServerRef.current = loadedServer;
      automaticServerSelectionRef.current = automatic;
      setSelectedServer(loadedServer);
      setAutomaticServerSelection(automatic);
    });
  }, []);

  const goForward = (to: Screen) => navigate(to, "forward");
  const goBack = (to: Screen) => navigate(to, "backward");

  // Force-reset to pairing screen — bypasses animating guard and closures.
  const forceGoToPairing = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setPrevScreen(null);
    setDirection("none");
    setAnimating(false);
    setCurrentScreen("pairing");
  }, []);

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const handleSplashDone = useCallback(() => {
    if (isPaired()) {
      markOnboardingSeen();
      navigateRef.current("home", "none");
    } else {
      navigateRef.current(hasSeenOnboarding() ? "pairing" : "onboarding", "none");
    }
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    markOnboardingSeen();
    navigateRef.current("pairing", "forward");
  }, []);

  const handlePaired = useCallback(() => {
    markOnboardingSeen();
    navigateRef.current("home", "forward");
    startDeviceLinkPolling();
  }, []);

  // Reactive navigation: observe session and auto-navigate to pairing
  // when the linked device-session is removed remotely, mirroring TV's
  // LaunchedEffect(authState) pattern.
  const session = useSession();
  const wasAuthenticatedRef = useRef(isPaired());

  useEffect(() => {
    const paired = session.isLinked;
    if (paired) {
      wasAuthenticatedRef.current = true;
    } else if (wasAuthenticatedRef.current) {
      wasAuthenticatedRef.current = false;
      forceGoToPairing();
    }
  }, [session.isLinked, forceGoToPairing]);

  useEffect(() => {
    if (!session.isLinked) {
      selectedServerRef.current = null;
      automaticServerSelectionRef.current = true;
      setSelectedServer(null);
      setAutomaticServerSelection(true);
      clearLastServer();
      return;
    }
    const loadedServer = loadLastServer();
    const automatic = loadAutomaticServerSelection();
    selectedServerRef.current = loadedServer;
    automaticServerSelectionRef.current = automatic;
    setSelectedServer(loadedServer);
    setAutomaticServerSelection(automatic);
  }, [session.isLinked, session.shortUuid]);

  useEffect(() => {
    if (!session.isLinked || !automaticServerSelection || selectedServer) return;
    const servers = getCachedVpnServers().filter(isAvailableVpnServer);
    if (servers.length === 0) return;
    let cancelled = false;
    void selectBestVpnServer(servers).then((best) => {
      if (cancelled || !best) return;
      const fresh = getCachedVpnServers()
        .filter(isAvailableVpnServer)
        .find((candidate) => isSameServerSelection(candidate, best));
      if (!fresh || !automaticServerSelectionRef.current) return;
      const resolved = toSelectedServer(fresh);
      selectedServerRef.current = resolved;
      setSelectedServer(resolved);
      saveLastServer(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [session.isLinked, session.shortUuid, automaticServerSelection, selectedServer]);

  // Subscription links can rotate UUID / Reality / transport parameters while
  // keeping the same visible server address. Keep the persisted selection and
  // any active tunnel on the fresh config instead of waiting for app data to
  // be cleared.
  useEffect(() => {
    let generation = 0;
    return subscribeVpnServers(() => {
      const currentGeneration = ++generation;
      const current = selectedServerRef.current;
      const servers = getCachedVpnServers().filter(isAvailableVpnServer);
      const automatic = automaticServerSelectionRef.current;
      if (servers.length === 0) {
        selectedServerRef.current = null;
        setSelectedServer(null);
        clearSelectedServer();
        const runtime = getVpnRuntime();
        if (runtime.connected || runtime.connecting) {
          void disconnectVpn().catch((error) => {
            console.error("Could not stop VPN after server access was revoked", error);
          });
        }
        return;
      }
      const matching = current
        ? servers.find((server) => isSameServerSelection(current, server)) ?? null
        : null;

      const applyFreshServer = (fresh: VpnServer) => {
        if (currentGeneration !== generation) return;
        const previous = selectedServerRef.current;
        const resolved = toSelectedServer(fresh);
        const vpnConfigChanged = !hasSameVpnConfig(previous, resolved);
        const displayChanged =
          previous?.name !== resolved.name ||
          previous?.country !== resolved.country;
        if (!vpnConfigChanged && !displayChanged) return;

        selectedServerRef.current = resolved;
        setSelectedServer(resolved);
        saveLastServer(resolved);

        // Background subscription refreshes can rotate links or fill metadata
        // while the user is only opening Settings/Subscription. Do not restart
        // a live tunnel from this passive event: explicit server selection and
        // manual connect still refresh the config before starting, and the
        // health-recovery path refreshes before reconnecting after a real
        // failure.
      };

      if (matching) {
        applyFreshServer(matching);
        return;
      }
      if (!automatic) {
        selectedServerRef.current = null;
        setSelectedServer(null);
        clearSelectedServer();
        return;
      }
      void selectBestVpnServer(servers).then((best) => {
        if (!best || !automaticServerSelectionRef.current) return;
        const latestSelection = selectedServerRef.current;
        const selectionUnchanged = current
          ? Boolean(latestSelection && isSameServerSelection(latestSelection, current))
          : latestSelection === null;
        if (!selectionUnchanged) return;
        const fresh = getCachedVpnServers()
          .filter(isAvailableVpnServer)
          .find((candidate) => isSameServerSelection(candidate, best));
        if (fresh) applyFreshServer(fresh);
      });
    });
  }, []);

  // Start device-link polling only after the startup update gate has finished.
  useEffect(() => {
    if (!browserPreview && startupComplete && isPaired()) {
      startDeviceLinkPolling();
    }
    return () => stopDeviceLinkPolling();
  }, [browserPreview, startupComplete]);

  // The window and the whole CSS frame share one scale. User changes resize
  // the native window and the transformed 494x895 design together; the same
  // path also keeps the existing small-screen adaptation for short laptops.
  useEffect(() => {
    const MONITOR_WIDTH_MARGIN = 32;
    const MONITOR_HEIGHT_MARGIN = 80;
    const generation = ++interfaceScaleResizeGenerationRef.current;

    const applyFrameLayoutForSize = (rawWidth: number, rawHeight: number) => {
      const viewportW = Math.max(1, rawWidth);
      const viewportH = Math.max(1, rawHeight);
      const wScale = viewportW / DESIGN_WINDOW_WIDTH;
      const hScale = viewportH / DESIGN_WINDOW_HEIGHT;
      const scale = Math.min(wScale, hScale);
      const clamped = Math.min(
        WINDOW_RENDER_SCALE_MAX,
        Math.max(WINDOW_RENDER_SCALE_MIN, scale),
      );
      document.documentElement.style.setProperty("--app-scale", String(clamped));
      document.documentElement.style.setProperty("--app-frame-width", `${viewportW / clamped}px`);
      document.documentElement.style.setProperty("--app-frame-height", `${viewportH / clamped}px`);
    };

    const applyFrameLayout = () => {
      applyFrameLayoutForSize(window.innerWidth, window.innerHeight);
    };

    let unlisten: (() => void) | undefined;
    let layoutAnimationFrame: number | null = null;
    let cancelled = false;

    // Native resize events can arrive in bursts. Updating the CSS frame more
    // than once per paint produced visible micro-jumps, especially on
    // WebKitGTK, so coalesce every burst into a single animation frame.
    const scheduleFrameLayout = () => {
      if (cancelled || layoutAnimationFrame !== null) return;
      layoutAnimationFrame = requestAnimationFrame(() => {
        layoutAnimationFrame = null;
        if (!cancelled) applyFrameLayout();
      });
    };

    if (browserPreview) {
      scheduleFrameLayout();
      window.addEventListener("resize", scheduleFrameLayout);
      return () => {
        cancelled = true;
        window.removeEventListener("resize", scheduleFrameLayout);
        if (layoutAnimationFrame !== null) cancelAnimationFrame(layoutAnimationFrame);
      };
    }

    (async () => {
      const win = getCurrentWindow();
      let appliedScale = interfaceScaleRequest.value;

      // Subscribe before the first native resize so the transformed CSS frame
      // follows every intermediate window size instead of catching up only at
      // the end (which looked like a flash on WebView2 / WebKitGTK).
      try {
        const handle = await win.onResized(scheduleFrameLayout);
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // We also schedule the layout after every animation step.
      }
      if (cancelled || generation !== interfaceScaleResizeGenerationRef.current) return;

      try {
        const mon = (await currentMonitor()) ?? (await primaryMonitor());
        if (mon) {
          const workArea = mon.workArea.size.toLogical(mon.scaleFactor);
          const monitorFit = Math.min(
            (workArea.width - MONITOR_WIDTH_MARGIN) / DESIGN_WINDOW_WIDTH,
            (workArea.height - MONITOR_HEIGHT_MARGIN) / DESIGN_WINDOW_HEIGHT,
          );
          appliedScale = Math.min(appliedScale, monitorFit / WINDOW_SCALE_BASE);
        }
      } catch {
        // Monitor discovery can fail on headless / unusual setups. The saved
        // scale is still safe because Tauri enforces the configured bounds.
      }

      appliedScale = Math.min(
        INTERFACE_SCALE_MAX,
        Math.max(INTERFACE_SCALE_MIN, appliedScale),
      );
      if (cancelled || generation !== interfaceScaleResizeGenerationRef.current) return;

      const windowScale = interfaceScaleToWindowScale(appliedScale);
      const startWidth = Math.max(1, window.innerWidth);
      const startHeight = Math.max(1, window.innerHeight);
      const targetWidth = Math.round(DESIGN_WINDOW_WIDTH * windowScale);
      const targetHeight = Math.round(DESIGN_WINDOW_HEIGHT * windowScale);
      const resizeDistance = Math.max(
        Math.abs(targetWidth - startWidth),
        Math.abs(targetHeight - startHeight),
      );
      // A button changes one 0.1 step and already felt smooth at 320 ms. A
      // slider can cross several steps at once, so scale the duration with the
      // travelled distance instead of squeezing a full-range resize into
      // roughly the same time as one button press.
      const durationMs = Math.min(1_050, Math.max(320, resizeDistance * 3.6));
      const startedAt = performance.now();
      let lastWidth = Math.round(startWidth);
      let lastHeight = Math.round(startHeight);

      while (!cancelled && generation === interfaceScaleResizeGenerationRef.current) {
        const progress = resizeDistance <= 1
          ? 1
          : Math.min(1, (performance.now() - startedAt) / durationMs);
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        const width = Math.round(startWidth + (targetWidth - startWidth) * eased);
        const height = Math.round(startHeight + (targetHeight - startHeight) * eased);

        if (width !== lastWidth || height !== lastHeight || progress >= 1) {
          // Prepare the CSS frame for the exact native size before yielding to
          // Tauri. Both changes are then painted together; waiting for the
          // delayed webview resize event made the interface visibly chase the
          // outer window by one or two frames.
          applyFrameLayoutForSize(width, height);
          try {
            await win.setSize(new LogicalSize(width, height));
            lastWidth = width;
            lastHeight = height;
          } catch {
            // Keep the current native size and derive the frame scale from it.
            applyFrameLayout();
            break;
          }
        }
        if (cancelled || generation !== interfaceScaleResizeGenerationRef.current) return;
        scheduleFrameLayout();
        if (progress >= 1) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (cancelled || generation !== interfaceScaleResizeGenerationRef.current) return;

      if (interfaceScaleRequest.centerAfterResize) {
        try {
          await win.center();
        } catch {
          // Resizing still succeeded; centring is a non-critical refinement.
        }
      }
      if (cancelled || generation !== interfaceScaleResizeGenerationRef.current) return;

      scheduleFrameLayout();
      // Fire a second pass on the next frame: setSize() resolves before
      // the webview has finished reflowing, so window.innerHeight isn't
      // yet the new value and our first scale computation would lag by
      // one paint.
      requestAnimationFrame(() => { if (!cancelled) scheduleFrameLayout(); });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      if (layoutAnimationFrame !== null) cancelAnimationFrame(layoutAnimationFrame);
    };
  }, [browserPreview, interfaceScaleRequest]);

  const renderScreen = (screen: Screen) => {
    switch (screen) {
      case "splash":
        return <SplashScreen onDone={handleSplashDone} browserPreview={browserPreview} />;
      case "onboarding":
        return <OnboardingScreen onContinue={handleOnboardingComplete} />;
      case "pairing":
        return <PairingScreen onPaired={handlePaired} />;
      case "home":
        return (
          <HomeScreen
            onLogout={() => goBack("pairing")}
            onSettings={() => {
              setSettingsSection("main");
              goForward("settings");
            }}
            onServers={() => goForward("servers")}
            onStats={() => goForward("stats")}
            onSpeedTest={() => goForward("speedtest")}
            selectedServer={selectedServer}
            automaticServerSelection={automaticServerSelection}
            autostartConnectRequested={autostartConnectRequested}
            onAutostartConnectHandled={() => setAutostartConnectRequested(false)}
            browserPreview={browserPreview}
            onServerChange={(server) => {
              selectedServerRef.current = server;
              setSelectedServer(server);
              saveLastServer(server);
            }}
          />
        );
      case "settings":
        return (
          <SettingsScreen
            onBack={() => goBack("home")}
            onLoggedOut={() => { stopDeviceLinkPolling(); forceGoToPairing(); }}
            onDevices={() => {
              setSettingsSection("advanced");
              goForward("devices");
            }}
            onRouting={() => {
              setSettingsSection("advanced");
              goForward("routing");
            }}
            onReferrals={() => {
              setSettingsSection("main");
              goForward("referrals");
            }}
            onPromocodes={() => {
              setSettingsSection("main");
              goForward("promocodes");
            }}
            interfaceScale={interfaceScaleRequest.value}
            onInterfaceScaleChange={requestInterfaceScale}
            fontScale={fontScale}
            onFontScaleChange={requestFontScale}
            boldText={boldText}
            onBoldTextChange={requestBoldText}
            outlinedText={outlinedText}
            onOutlinedTextChange={requestOutlinedText}
            onSectionChange={setSettingsSection}
            initialSection={
              browserPreview && ["main", "personalization", "displayScale", "advanced", "support", "about"].includes(
                new URLSearchParams(window.location.search).get("settingsSection") ?? "",
              )
                ? (new URLSearchParams(window.location.search).get("settingsSection") as
                    | "main"
                    | "personalization"
                    | "displayScale"
                    | "advanced"
                    | "support"
                    | "about")
                : settingsSection
            }
          />
        );
      case "devices":
        return <DevicesScreen onBack={() => goBack("settings")} />;
      case "routing":
        return <RoutingScreen onBack={() => goBack("settings")} />;
      case "referrals":
        return (
          <ReferralsScreen
            onBack={() => goBack("settings")}
            browserPreview={browserPreview}
          />
        );
      case "promocodes":
        return (
          <PromocodesScreen
            onBack={() => goBack("settings")}
            browserPreview={browserPreview}
          />
        );
      case "servers":
        return (
          <ServersScreen
            onBack={() => goBack("home")}
            selectedServer={selectedServer}
            automaticServerSelection={automaticServerSelection}
            onSelect={(vpnServer) => {
              // Keep a second guard behind ServersScreen so a stale click
              // cannot persist or live-switch to a server that just went down.
              if (!isAvailableVpnServer(vpnServer)) return;
              const server = toSelectedServer(vpnServer);
              const prev = selectedServer;
              automaticServerSelectionRef.current = false;
              setAutomaticServerSelection(false);
              saveAutomaticServerSelection(false);
              selectedServerRef.current = server;
              setSelectedServer(server);
              saveLastServer(server);
              goBack("home");
              // Live-switch: if a session is already up (or in flight) and the
              // user picked a different server, reconnect to the new one. The
              // backend's start() tears down the previous session itself.
              const sameConfig = hasSameVpnConfig(prev, server);
              const runtime = getVpnRuntime();
              if (!sameConfig && (runtime.connected || runtime.connecting)) {
                void connectVpn({
                  address: server.address,
                  port: server.port,
                  uuid: server.uuid,
                  flow: server.flow,
                  security: server.security,
                  sni: server.sni,
                  fingerprint: server.fingerprint,
                  public_key: server.public_key,
                  short_id: server.short_id,
                  network: server.network,
                  path: server.path,
                  mode: server.mode,
                  spx: server.spx,
                }).catch((e) => {
                  console.error("[VPN] live-switch failed:", e);
                  if (!prev || !getVpnRuntime().connected) return;
                  setSelectedServer((current) => {
                    if (!current || !isSameServerSelection(current, server)) return current;
                    selectedServerRef.current = prev;
                    saveLastServer(prev);
                    return prev;
                  });
                });
              }
            }}
            onSelectAutomatic={(vpnServer) => {
              if (!isAvailableVpnServer(vpnServer)) return;
              const server = toSelectedServer(vpnServer);
              const prev = selectedServer;
              automaticServerSelectionRef.current = true;
              setAutomaticServerSelection(true);
              saveAutomaticServerSelection(true);
              selectedServerRef.current = server;
              setSelectedServer(server);
              saveLastServer(server);
              goBack("home");

              const sameConfig = hasSameVpnConfig(prev, server);
              const runtime = getVpnRuntime();
              if (!sameConfig && (runtime.connected || runtime.connecting)) {
                void connectVpn({
                  address: server.address,
                  port: server.port,
                  uuid: server.uuid,
                  flow: server.flow,
                  security: server.security,
                  sni: server.sni,
                  fingerprint: server.fingerprint,
                  public_key: server.public_key,
                  short_id: server.short_id,
                  network: server.network,
                  path: server.path,
                  mode: server.mode,
                  spx: server.spx,
                }).catch((e) => {
                  console.error("[VPN] automatic live-switch failed:", e);
                  if (!prev || !getVpnRuntime().connected) return;
                  setSelectedServer((current) => {
                    if (!current || !isSameServerSelection(current, server)) return current;
                    selectedServerRef.current = prev;
                    saveLastServer(prev);
                    return prev;
                  });
                });
              }
            }}
          />
        );
      case "stats":
        return <StatsScreen onBack={() => goBack("home")} />;
      case "speedtest":
        return <SpeedTestScreen onBack={() => goBack("home")} />;
    }
  };

  const enterClass =
    direction === "forward"
      ? "screen-enter-from-right"
      : direction === "backward"
        ? "screen-enter-from-left"
        : "";

  const exitClass =
    direction === "forward"
      ? "screen-exit-to-left"
      : direction === "backward"
        ? "screen-exit-to-right"
        : "";

  return (
    <main className={`app ${useWindowsFrame ? "app--windows-frame" : ""}`}>
      {useWindowsFrame && <WindowsTitleBar />}
      <div className="app__content">
      <AppErrorBoundary>
        {prevScreen && (
          <div key={prevScreen} className={`screen-layer ${exitClass}`}>
            {renderScreen(prevScreen)}
          </div>
        )}
        <div
          key={currentScreen}
          className={`screen-layer ${prevScreen ? enterClass : ""}`}
        >
          {renderScreen(currentScreen)}
        </div>
        {/* Overlay above every screen. We portal it onto a dedicated
            #overlay-root sibling of #root (declared in index.html) so it
            sits outside the .app container's overflow:hidden and the
            screen-transition transforms — both create new containing
            blocks that break position:fixed under WebKitGTK on Linux. */}
        {!browserPreview && !updateRequired && currentScreen !== "splash" && currentScreen !== "onboarding" && currentScreen !== "pairing" &&
          (() => {
            const target = document.getElementById("overlay-root") ?? document.body;
            return createPortal(
              <div className="update-banner-overlay">
                <UpdateBanner />
              </div>,
              target,
            );
          })()}
      </AppErrorBoundary>
      </div>
    </main>
  );
}
