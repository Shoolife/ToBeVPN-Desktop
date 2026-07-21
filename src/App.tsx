import { useState, useRef, useEffect, useCallback, useSyncExternalStore, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, primaryMonitor } from "@tauri-apps/api/window";
import SplashScreen from "./screens/SplashScreen";
import OnboardingScreen from "./screens/OnboardingScreen";
import PairingScreen from "./screens/PairingScreen";
import HomeScreen from "./screens/HomeScreen";
import SettingsScreen from "./screens/SettingsScreen";
import ServersScreen from "./screens/ServersScreen";
import StatsScreen from "./screens/StatsScreen";
import SpeedTestScreen from "./screens/SpeedTestScreen";
import DevicesScreen from "./screens/DevicesScreen";
import RoutingScreen from "./screens/RoutingScreen";
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
import "./App.css";

export type Screen = "splash" | "onboarding" | "pairing" | "home" | "settings" | "servers" | "stats" | "speedtest" | "devices" | "routing";

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

export default function App({
  initialScreen = "splash",
  browserPreview = false,
}: {
  initialScreen?: Screen;
  browserPreview?: boolean;
}) {
  const [currentScreen, setCurrentScreen] = useState<Screen>(initialScreen);
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
  const useWindowsFrame = shouldUseWindowsFrame(browserPreview);
  const timeoutRef = useRef<number | null>(null);

  const DURATION = 300;

  useEffect(() => {
    if (useWindowsFrame) document.documentElement.dataset.windowFrame = "windows";
    else delete document.documentElement.dataset.windowFrame;
  }, [useWindowsFrame]);

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

  // Adaptive scaling for laptops whose screen height is below the design
  // target of 895px (1366x768 / 1280x720 / netbooks). The CSS frame is
  // deliberately larger in unscaled pixels when needed, so after transform
  // scaling it covers the whole native window instead of leaving side gutters.
  useEffect(() => {
    const DESIGN_W = 494;
    const DESIGN_H = 895;
    const MIN_SCALE = 0.55;
    const SCREEN_MARGIN_PX = 80;

    const applyFrameLayout = () => {
      const viewportW = Math.max(1, window.innerWidth);
      const viewportH = Math.max(1, window.innerHeight);
      const wScale = viewportW / DESIGN_W;
      const hScale = viewportH / DESIGN_H;
      const scale = Math.min(wScale, hScale);
      const clamped = Math.min(1, Math.max(MIN_SCALE, scale));
      document.documentElement.style.setProperty("--app-scale", String(clamped));
      document.documentElement.style.setProperty("--app-frame-width", `${viewportW / clamped}px`);
      document.documentElement.style.setProperty("--app-frame-height", `${viewportH / clamped}px`);
    };

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const mon = await primaryMonitor();
        if (!cancelled && mon) {
          const usableH = mon.size.height / mon.scaleFactor - SCREEN_MARGIN_PX;
          if (usableH < DESIGN_H) {
            const scale = Math.max(MIN_SCALE, usableH / DESIGN_H);
            const win = getCurrentWindow();
            await win.setSize(
              new LogicalSize(
                Math.round(DESIGN_W * scale),
                Math.round(DESIGN_H * scale),
              ),
            );
            await win.center();
          }
        }
      } catch {
        // primaryMonitor() can fail on headless / unusual setups —
        // applyFrameLayout below still produces a sensible scale
        // from whatever size the window ended up at.
      }
      if (cancelled) return;
      applyFrameLayout();
      // Fire a second pass on the next frame: setSize() resolves before
      // the webview has finished reflowing, so window.innerHeight isn't
      // yet the new value and our first scale computation would lag by
      // one paint.
      requestAnimationFrame(() => { if (!cancelled) applyFrameLayout(); });

      try {
        const win = getCurrentWindow();
        const handle = await win.onResized(() => applyFrameLayout());
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // ignore — without the listener resize won't update the scale
        // live, but the initial fit on mount is already correct.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
            onSettings={() => goForward("settings")}
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
            onDevices={() => goForward("devices")}
            onRouting={() => goForward("routing")}
          />
        );
      case "devices":
        return <DevicesScreen onBack={() => goBack("settings")} />;
      case "routing":
        return <RoutingScreen onBack={() => goBack("settings")} />;
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
