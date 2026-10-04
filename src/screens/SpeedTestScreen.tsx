import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useVpnRuntime } from "../session/vpnState";
import {
  downloadColor,
  pingColor,
  useSpeedTestHistory,
  type SpeedTestPhase,
} from "../session/speedTest";
import {
  isSpeedTestRunning,
  resetSpeedTestRun,
  startSpeedTestRun,
  useSpeedTestRun,
} from "../session/speedTestRun";
import MaterialIcon from "../components/MaterialIcon";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import "./SpeedTestScreen.css";

// Same layout and animation as the Android client's SpeedTestScreen.
// The old 200 Mbps scale saturated below modern tariffs; 500 Mbps keeps a
// 300 Mbps result readable, as on the phone.
const MAX_SPEED = 500;

export default function SpeedTestScreen({
  onBack,
  onOpenHistory,
}: {
  onBack: () => void;
  onOpenHistory: () => void;
}) {
  // The run lives in session/speedTestRun, so it keeps going while History is
  // open, as on the phone.
  const state = useSpeedTestRun();
  const history = useSpeedTestHistory();

  // On desktop the OS routes the Rust process through the tunnel when the VPN
  // is up, so the badge only tells the user which path the result reflects.
  const { connected: vpnConnected } = useVpnRuntime();

  const startTest = () => void startSpeedTestRun(vpnConnected);
  const resetTest = resetSpeedTestRun;

  const running = isSpeedTestRunning(state);
  const successful = state.phase === "done" && state.error === null && state.download > 0;
  const showStages = state.error === null &&
    (state.phase === "ping" || state.phase === "download" || state.phase === "done");

  const phaseText =
    state.error ? state.error
    : state.phase === "idle" ? t("speed_press_start")
    : state.phase === "checking" ? t("speed_checking_connection")
    : state.phase === "ping" ? t("speed_measuring_ping")
    : state.phase === "download" ? t("speed_downloading")
    : t("speed_done");

  const pingText = state.ping > 0 ? String(state.ping) : "—";
  const downloadText = state.download > 0 ? state.download.toFixed(1) : "—";

  return (
    <div className="speed-root">
      <div className="speed-topbar">
        <button className="speed-topbar__back" onClick={onBack} aria-label={t("back")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="speed-topbar__title">{t("speed_test_title")}</span>
        <span className={`speed-vpn-badge ${vpnConnected ? "speed-vpn-badge--on" : "speed-vpn-badge--off"}`}>
          {vpnConnected ? t("speed_via_vpn") : t("speed_direct")}
        </span>
      </div>

      <ScrollEdgeAffordance className="speed-content">
        <div className="speed-main">
          <SpeedGauge
            speed={state.currentSpeed}
            phase={state.phase}
            hasError={state.error !== null}
            successful={successful}
          />

          <div
            key={`${state.phase}:${state.error ?? ""}`}
            className={`speed-phase ${state.error ? "speed-phase--error" : ""} ${successful ? "speed-phase--done" : ""}`}
          >
            {phaseText}
          </div>

          <div className={`speed-stages ${showStages ? "speed-stages--visible" : ""}`} aria-hidden={!showStages}>
            <StageChip
              label={t("speed_ping")}
              active={state.phase === "ping"}
              completed={state.phase === "download" || state.phase === "done"}
            />
            <StageChip
              label={t("speed_download")}
              active={state.phase === "download"}
              completed={state.phase === "done"}
            />
          </div>

          <div className="speed-results">
            <ResultCard
              label={t("speed_ping")}
              value={pingText}
              unit={t("speed_unit_ms")}
              color={pingColor(state.ping)}
            />
            <ResultCard
              label={t("speed_download")}
              value={downloadText}
              unit={t("speed_unit_mbps")}
              color={state.download > 0 ? downloadColor(state.download) : "var(--text-muted)"}
            />
          </div>
        </div>

        <button className="speed-history-btn" onClick={onOpenHistory}>
          <MaterialIcon name="history" size={20} />
          <span className="speed-history-btn__label">{t("speed_history_title")}</span>
          {history.length > 0 && <span className="speed-history-btn__count">{history.length}</span>}
        </button>

        <button className="speed-start-btn" onClick={running ? resetTest : startTest}>
          {running ? t("speed_stop") : t("speed_start_test")}
        </button>
      </ScrollEdgeAffordance>
    </div>
  );
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const rad = (d: number) => (d * Math.PI) / 180;
  const sx = cx + r * Math.cos(rad(startDeg));
  const sy = cy + r * Math.sin(rad(startDeg));
  const ex = cx + r * Math.cos(rad(endDeg));
  const ey = cy + r * Math.sin(rad(endDeg));
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`;
}

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/**
 * Animated gauge: the value eases over 420 ms, the ping phase sweeps the
 * needle back and forth, and a successful run ends with a burst and a check.
 */
function SpeedGauge({
  speed,
  phase,
  hasError,
  successful,
}: {
  speed: number;
  phase: SpeedTestPhase;
  hasError: boolean;
  successful: boolean;
}) {
  const target = Math.min(Math.max(speed / MAX_SPEED, 0), 1);
  const [fraction, setFraction] = useState(target);
  const [scan, setScan] = useState(0.06);
  const fromRef = useRef(target);
  const shownRef = useRef(target);

  useEffect(() => {
    fromRef.current = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min((now - start) / 420, 1);
      const value = fromRef.current + (target - fromRef.current) * easeInOut(k);
      shownRef.current = value;
      setFraction(value);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  useEffect(() => {
    if (phase !== "ping") return;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const cycle = ((now - start) / 900) % 2;
      const k = easeInOut(cycle <= 1 ? cycle : 2 - cycle);
      setScan(0.06 + 0.88 * k);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const inactive = phase === "idle" || phase === "checking" || hasError;
  const runningVisual = phase === "ping" || phase === "download";
  const visual = phase === "ping" ? scan : fraction;
  const color =
    phase === "ping" ? "var(--info)"
    : speed < 25 ? "var(--danger)"
    : speed < 75 ? "var(--warning)"
    : speed < 150 ? "var(--success)"
    : "var(--info)";

  const size = 280;
  const stroke = 16;
  const pad = stroke / 2 + 8;
  const c = size / 2;
  const r = (size - pad * 2) / 2;
  const startAngle = 150;
  const sweep = 240;
  const needleRad = ((startAngle + sweep * visual) * Math.PI) / 180;
  const needleLen = r - stroke - 16;

  return (
    <div className={`speed-gauge ${inactive ? "speed-gauge--inactive" : ""}`}>
      <svg className="speed-gauge__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {runningVisual && <circle className="speed-gauge__pulse" cx={c} cy={c} r={size * 0.43} />}
        <path
          d={describeArc(c, c, r, startAngle, startAngle + sweep)}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {visual > 0.001 && (
          <path
            d={describeArc(c, c, r, startAngle, startAngle + sweep * visual)}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            style={{ transition: "stroke 300ms" }}
          />
        )}
        {Array.from({ length: 11 }, (_, i) => {
          const rad = ((startAngle + (sweep * i) / 10) * Math.PI) / 180;
          const inner = r - stroke / 2 - 6;
          const outer = r - stroke / 2 - 2;
          return (
            <line
              key={i}
              x1={c + inner * Math.cos(rad)} y1={c + inner * Math.sin(rad)}
              x2={c + outer * Math.cos(rad)} y2={c + outer * Math.sin(rad)}
              stroke="var(--surface-2)"
              strokeWidth={2}
            />
          );
        })}
        {!inactive && (
          <>
            <line
              x1={c} y1={c}
              x2={c + needleLen * Math.cos(needleRad)} y2={c + needleLen * Math.sin(needleRad)}
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
            />
            <circle cx={c} cy={c} r={6} fill={color} />
          </>
        )}
        {successful && (
          <g className="speed-gauge__burst">
            {Array.from({ length: 12 }, (_, i) => {
              const angle = ((i * 30 - 90) * Math.PI) / 180;
              return (
                <circle
                  key={i}
                  className="speed-gauge__particle"
                  cx={c + r * 0.82 * Math.cos(angle)}
                  cy={c + r * 0.82 * Math.sin(angle)}
                  r={2.8}
                  style={{ ["--dx" as string]: `${r * 0.22 * Math.cos(angle)}px`, ["--dy" as string]: `${r * 0.22 * Math.sin(angle)}px` }}
                />
              );
            })}
          </g>
        )}
      </svg>
      <div className="speed-gauge__center">
        <span className="speed-gauge__value">{inactive ? "0" : speed.toFixed(1)}</span>
        <span className="speed-gauge__unit">{t("speed_unit_mbps")}</span>
      </div>
      {successful && (
        <span className="speed-gauge__check" aria-hidden="true">
          <MaterialIcon name="checkCircle" size={26} />
        </span>
      )}
    </div>
  );
}

function StageChip({ label, active, completed }: { label: string; active: boolean; completed: boolean }) {
  const state = completed ? "done" : active ? "active" : "idle";
  return (
    <div className={`speed-stage speed-stage--${state}`}>
      {completed
        ? <MaterialIcon name="checkCircle" size={17} />
        : <span className="speed-stage__dot" />}
      <span className="speed-stage__label">{label}</span>
    </div>
  );
}

function ResultCard({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <div className="speed-result">
      <span className="speed-result__label">{label}</span>
      <span key={value} className="speed-result__value" style={{ color }}>{value}</span>
      <span className="speed-result__unit">{unit}</span>
    </div>
  );
}
