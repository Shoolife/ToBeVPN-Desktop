import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
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
import AppErrorBoundary from "./components/AppErrorBoundary";
import UpdateBanner from "./components/UpdateBanner";
import { isPaired, useSession } from "./session/store";
import { startDeviceLinkPolling, stopDeviceLinkPolling } from "./session/auth";
import { isSameServerSelection } from "./session/serverSelection";
import { connectVpn, getVpnRuntime } from "./session/vpnState";
import { clearLastServer, loadLastServer, saveLastServer } from "./session/lastServer";
import "./App.css";

export type Screen = "splash" | "onboarding" | "pairing" | "home" | "settings" | "servers" | "stats" | "speedtest" | "devices";

const ONBOARDING_SEEN_KEY = "tobevpn_onboarding_seen_v1";

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

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>("splash");
  const [prevScreen, setPrevScreen] = useState<Screen | null>(null);
  const [direction, setDirection] = useState<Direction>("none");
  const [animating, setAnimating] = useState(false);
  const [selectedServer, setSelectedServer] = useState<SelectedServer | null>(() => loadLastServer());
  const timeoutRef = useRef<number | null>(null);

  const DURATION = 300;

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
      setSelectedServer(null);
      clearLastServer();
      return;
    }
    setSelectedServer(loadLastServer());
  }, [session.isLinked, session.shortUuid]);

  // Start device-link polling when already authenticated on mount.
  useEffect(() => {
    if (isPaired()) {
      startDeviceLinkPolling();
    }
    return () => stopDeviceLinkPolling();
  }, []);

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
        return <SplashScreen onDone={handleSplashDone} />;
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
            onServerChange={(server) => {
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
          />
        );
      case "devices":
        return <DevicesScreen onBack={() => goBack("settings")} />;
      case "servers":
        return (
          <ServersScreen
            onBack={() => goBack("home")}
            selectedServer={selectedServer}
            onSelect={(server) => {
              const prev = selectedServer;
              setSelectedServer(server);
              saveLastServer(server);
              goBack("home");
              // Live-switch: if a session is already up (or in flight) and the
              // user picked a different server, reconnect to the new one. The
              // backend's start() tears down the previous session itself.
              const sameAsPrev = isSameServerSelection(prev, server);
              // Skip the live-switch entirely when the user picked the
              // panel's "subscription expired" sentinel. ServersScreen
              // already filters it out of the list, but a stale cache
              // could still surface it on first launch after upgrade
              // — never feed it to the engine.
              const sentinel =
                server.uuid === "00000000-0000-0000-0000-000000000000" ||
                !server.address ||
                server.address === "127.0.0.1" ||
                server.address === "0.0.0.0";
              const runtime = getVpnRuntime();
              if (!sentinel && !sameAsPrev && (runtime.connected || runtime.connecting)) {
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
    <main className="app">
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
        {currentScreen !== "splash" && currentScreen !== "onboarding" && currentScreen !== "pairing" &&
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
    </main>
  );
}
