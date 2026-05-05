import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import SplashScreen from "./screens/SplashScreen";
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
import { connectVpn, getVpnRuntime } from "./session/vpnState";
import { loadLastServer, saveLastServer } from "./session/lastServer";
import "./App.css";

export type Screen = "splash" | "pairing" | "home" | "settings" | "servers" | "stats" | "speedtest" | "devices";

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
    navigateRef.current(isPaired() ? "home" : "pairing", "none");
  }, []);

  const handlePaired = useCallback(() => {
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

  // Start device-link polling when already authenticated on mount.
  useEffect(() => {
    if (isPaired()) {
      startDeviceLinkPolling();
    }
    return () => stopDeviceLinkPolling();
  }, []);

  const renderScreen = (screen: Screen) => {
    switch (screen) {
      case "splash":
        return <SplashScreen onDone={handleSplashDone} />;
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
            onSelect={(server) => {
              const prev = selectedServer;
              setSelectedServer(server);
              saveLastServer(server);
              goBack("home");
              // Live-switch: if a session is already up (or in flight) and the
              // user picked a different server, reconnect to the new one. The
              // backend's start() tears down the previous session itself.
              const sameAsPrev =
                prev &&
                prev.address === server.address &&
                prev.port === server.port &&
                prev.uuid === server.uuid;
              const runtime = getVpnRuntime();
              if (!sameAsPrev && (runtime.connected || runtime.connecting)) {
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
                }).catch((e) => console.error("[VPN] live-switch failed:", e));
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
        {currentScreen !== "splash" && currentScreen !== "pairing" &&
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
