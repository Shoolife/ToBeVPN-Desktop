import { useState, useRef, useEffect } from "react";
import { t } from "../i18n";
import { useVpnRuntime } from "../session/vpnState";
import "./SpeedTestScreen.css";

type Phase = "idle" | "ping" | "download" | "done";

const MAX_SPEED = 200; // Mbps

// Continuous-download endpoints rotated through during the 10-second window.
// Cloudflare's /__down?bytes=N serves up to ~1 GB chunks — we use multiple
// distinct sizes so nothing gets cached between iterations and the test
// reflects real bandwidth instead of a single warm cache hit. Mirrors phone's
// rotation through Maven Central jars (icu4j, guava).
const DOWNLOAD_URLS = [
  "https://speed.cloudflare.com/__down?bytes=104857600",   // 100 MB
  "https://speed.cloudflare.com/__down?bytes=52428800",    // 50 MB
  "https://speed.cloudflare.com/__down?bytes=26214400",    // 25 MB
];
const PING_URL = "https://speed.cloudflare.com/__down?bytes=1";
const PING_COUNT = 3;
const TEST_DURATION_MS = 10_000;

function gaugeColor(speed: number): string {
  if (speed < 10) return "var(--danger)";
  if (speed < 30) return "var(--warning)";
  if (speed < 60) return "var(--success)";
  return "var(--info)";
}

function pingColorClass(ping: number): string {
  if (ping <= 0) return "speed-result__value--muted";
  if (ping <= 100) return "speed-result__value--green";
  if (ping <= 200) return "speed-result__value--orange";
  return "speed-result__value--red";
}

// SVG arc helper — 240° sweep from 150° to 30° (through bottom going clockwise through top).
// In SVG with clockwise rotation, start angle 150° (bottom-left), sweep 240°.
function describeArc(cx: number, cy: number, r: number, startAngleDeg: number, endAngleDeg: number): string {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const sx = cx + r * Math.cos(toRad(startAngleDeg));
  const sy = cy + r * Math.sin(toRad(startAngleDeg));
  const ex = cx + r * Math.cos(toRad(endAngleDeg));
  const ey = cy + r * Math.sin(toRad(endAngleDeg));
  const sweep = endAngleDeg - startAngleDeg;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`;
}

export default function SpeedTestScreen({ onBack }: { onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [ping, setPing] = useState(-1);
  const [download, setDownload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  // Mirrors phone's `viaVpn` StateFlow. On desktop tun2socks captures all
  // traffic from the webview through TUN when connected, so any fetch() here
  // automatically goes through the tunnel — but we still surface the indicator
  // so users understand which path the result reflects.
  const { connected: vpnConnected } = useVpnRuntime();

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const measurePing = async (signal: AbortSignal): Promise<number> => {
    const ping = async (): Promise<number | null> => {
      const start = performance.now();
      try {
        const res = await fetch(PING_URL, { cache: "no-store", signal });
        await res.arrayBuffer();
        return Math.round(performance.now() - start);
      } catch {
        return null;
      }
    };

    // Warmup — primes DNS / TLS / connection cache so the first measured
    // request reflects steady-state latency.
    if ((await ping()) === null) return -1;

    const results: number[] = [];
    for (let i = 0; i < PING_COUNT; i++) {
      if (signal.aborted) return -1;
      const ms = await ping();
      if (ms !== null) results.push(ms);
    }
    if (results.length === 0) return -1;
    results.sort((a, b) => a - b);
    return results[Math.floor(results.length / 2)];
  };

  // Mirrors phone's measureDownload: deadline-driven loop that keeps reading
  // bytes from rotating endpoints for TEST_DURATION_MS, reporting live speed
  // every ~200ms. Compared to a fixed-size single-fetch this is more accurate
  // on fast links (where 25MB is over in 1s) and resilient to a single
  // endpoint stalling mid-test.
  const measureDownload = async (
    signal: AbortSignal,
    onProgress: (mbps: number) => void,
  ): Promise<number> => {
    const startTime = performance.now();
    const deadline = startTime + TEST_DURATION_MS;
    let totalBytes = 0;
    let lastReport = startTime;
    let urlIndex = 0;

    while (performance.now() < deadline && !signal.aborted) {
      const url = DOWNLOAD_URLS[urlIndex % DOWNLOAD_URLS.length];
      urlIndex++;

      let res: Response;
      try {
        res = await fetch(url, { signal, cache: "no-store" });
      } catch {
        // One endpoint may be unreachable through the tunnel; keep going
        // with the next URL — only fail if every endpoint fails.
        continue;
      }
      if (!res.ok || !res.body) continue;

      const reader = res.body.getReader();
      while (performance.now() < deadline && !signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        const now = performance.now();
        if (now - lastReport >= 200) {
          const elapsedSec = (now - startTime) / 1000;
          if (elapsedSec > 0) {
            onProgress((totalBytes * 8) / (elapsedSec * 1_000_000));
          }
          lastReport = now;
        }
      }
      // Drop the rest of the body — we control the loop, not the file size.
      try {
        await reader.cancel();
      } catch {
        // already done
      }
    }

    const elapsedSec = (performance.now() - startTime) / 1000;
    return elapsedSec > 0 ? (totalBytes * 8) / (elapsedSec * 1_000_000) : 0;
  };

  const startTest = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCurrentSpeed(0);
    setPing(-1);
    setDownload(0);
    setError(null);
    setPhase("ping");

    try {
      const pingMs = await measurePing(controller.signal);
      if (controller.signal.aborted) return;
      if (pingMs < 0) {
        setError(t("speed_no_connection"));
        setPhase("done");
        return;
      }
      setPing(pingMs);

      setPhase("download");
      const finalMbps = await measureDownload(controller.signal, (mbps) => {
        setCurrentSpeed(mbps);
      });
      if (controller.signal.aborted) return;

      if (finalMbps <= 0) {
        setError(t("speed_measure_failed"));
      }
      setDownload(finalMbps);
      setCurrentSpeed(finalMbps);
      setPhase("done");
    } catch {
      if (!controller.signal.aborted) {
        setError(t("speed_measure_failed"));
        setPhase("done");
      }
    } finally {
      runningRef.current = false;
    }
  };

  const resetTest = () => {
    abortRef.current?.abort();
    runningRef.current = false;
    setPhase("idle");
    setCurrentSpeed(0);
    setError(null);
  };

  const handleBtnClick = () => {
    if (phase === "idle" || phase === "done") startTest();
    else resetTest();
  };

  const fraction = Math.min(currentSpeed / MAX_SPEED, 1);
  const arcColor = gaugeColor(currentSpeed);

  // Gauge geometry
  const size = 320;
  const stroke = 18;
  const pad = stroke / 2 + 8;
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - pad * 2) / 2;

  // Arc spans from 150° to 30° (clockwise through 180° → 270° → 0° → 30°), sweep = 240°
  const startAngle = 150;
  const fullEnd = 150 + 240; // 390 ≡ 30
  const valueEnd = 150 + 240 * fraction;

  const trackPath = describeArc(cx, cy, r, startAngle, fullEnd);
  const valuePath = fraction > 0.001 ? describeArc(cx, cy, r, startAngle, valueEnd) : "";

  // Needle
  const needleAngleDeg = startAngle + 240 * fraction;
  const needleRad = (needleAngleDeg * Math.PI) / 180;
  const needleLen = r - stroke - 16;
  const needleX = cx + needleLen * Math.cos(needleRad);
  const needleY = cy + needleLen * Math.sin(needleRad);

  // Ticks
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const angle = startAngle + (240 * i) / 10;
    const rad = (angle * Math.PI) / 180;
    const innerR = r - stroke / 2 - 6;
    const outerR = r - stroke / 2 - 2;
    return {
      x1: cx + innerR * Math.cos(rad),
      y1: cy + innerR * Math.sin(rad),
      x2: cx + outerR * Math.cos(rad),
      y2: cy + outerR * Math.sin(rad),
    };
  });

  const phaseText =
    error ? error
    : phase === "idle" ? t("speed_press_start")
    : phase === "ping" ? t("speed_measuring_ping")
    : phase === "download" ? t("speed_downloading")
    : t("speed_done");

  const btnText =
    phase === "idle" || phase === "done" ? t("speed_start_test") : t("speed_stop");

  return (
    <div className="speed-root">
      <div className="speed-topbar">
        <button className="speed-topbar__back" onClick={onBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="speed-topbar__title">{t("speed_test_title")}</span>
        <span
          className={`speed-vpn-badge ${vpnConnected ? "speed-vpn-badge--on" : "speed-vpn-badge--off"}`}
          title={vpnConnected ? t("speed_via_vpn") : t("speed_direct")}
        >
          {vpnConnected ? t("speed_via_vpn") : t("speed_direct")}
        </span>
      </div>

      <div className="speed-content">
        <div className="speed-gauge">
          <svg className="speed-gauge__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {/* Track */}
            <path
              d={trackPath}
              fill="none"
              stroke="var(--surface-2)"
              strokeWidth={stroke}
              strokeLinecap="round"
            />
            {/* Value arc */}
            {valuePath && (
              <path
                d={valuePath}
                fill="none"
                stroke={arcColor}
                strokeWidth={stroke}
                strokeLinecap="round"
                style={{ transition: "stroke 300ms" }}
              />
            )}
            {/* Ticks */}
            {ticks.map((tk, i) => (
              <line
                key={i}
                x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2}
                stroke="var(--surface-2)"
                strokeWidth={2}
              />
            ))}
            {/* Needle */}
            {phase !== "idle" && (
              <>
                <line
                  x1={cx} y1={cy} x2={needleX} y2={needleY}
                  stroke={arcColor}
                  strokeWidth={3}
                  strokeLinecap="round"
                />
                <circle cx={cx} cy={cy} r={6} fill={arcColor} />
              </>
            )}
          </svg>
          <div className="speed-gauge__center">
            <span className="speed-gauge__value">
              {phase === "idle" ? "0" : currentSpeed.toFixed(1)}
            </span>
            <span className="speed-gauge__unit">{t("speed_unit_mbps")}</span>
          </div>
        </div>

        <div className="speed-phase">{phaseText}</div>

        <div className="speed-results">
          <div className="speed-result">
            <span className="speed-result__label">{t("speed_ping")}</span>
            <span className={`speed-result__value ${pingColorClass(ping)}`}>
              {ping >= 0 ? ping : "—"}
            </span>
            <span className="speed-result__unit">{t("speed_unit_ms")}</span>
          </div>
          <div className="speed-result">
            <span className="speed-result__label">{t("speed_download")}</span>
            <span className={`speed-result__value ${download > 0 ? "speed-result__value--green" : "speed-result__value--muted"}`}>
              {download > 0 ? download.toFixed(1) : "—"}
            </span>
            <span className="speed-result__unit">{t("speed_unit_mbps")}</span>
          </div>
        </div>

        <button className="speed-start-btn" onClick={handleBtnClick}>
          {btnText}
        </button>
      </div>
    </div>
  );
}
