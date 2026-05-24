import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { initializeAuthSession } from "../session/auth";
import "./SplashScreen.css";

export default function SplashScreen({ onDone }: { onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  const [slowStart, setSlowStart] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    let cancelled = false;
    let leaveTimer: number | null = null;
    let doneTimer: number | null = null;
    const slowStartTimer = window.setTimeout(() => {
      if (!cancelled) setSlowStart(true);
    }, 2200);

    void (async () => {
      const startedAt = Date.now();
      try {
        await initializeAuthSession();
      } catch (error) {
        console.error("[splash] initializeAuthSession failed:", error);
      }
      const remainingDelay = Math.max(0, SPLASH_HOLD_MS - (Date.now() - startedAt));
      leaveTimer = window.setTimeout(() => {
        if (cancelled) return;
        setLeaving(true);
        doneTimer = window.setTimeout(() => {
          if (!cancelled) onDoneRef.current();
        }, SPLASH_EXIT_MS);
      }, remainingDelay);
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(slowStartTimer);
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      if (doneTimer !== null) window.clearTimeout(doneTimer);
    };
  }, []);

  return (
    <div className={`splash-root ${leaving ? "splash-root--leaving" : ""}`}>
      <div className="splash-content">
        <div className="splash-shield-wrap">
          <div className="splash-glow" />
          <svg viewBox="0 0 100 100" className="splash-shield">
            <defs>
              <linearGradient
                id="shieldGradient"
                x1="22%"
                y1="12%"
                x2="78%"
                y2="88%"
              >
                <stop offset="0%" stopColor="#00E5A0" />
                <stop offset="50%" stopColor="#00BCD4" />
                <stop offset="100%" stopColor="#2196F3" />
              </linearGradient>
            </defs>
            <path
              className="splash-shield-path"
              d="M50,12 C55,12 78,18 78,22 C78,50 72,68 50,88 C28,68 22,50 22,22 C22,18 45,12 50,12 Z"
              stroke="url(#shieldGradient)"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="splash-chevron-trail"
              d="M34,41 L46,50 L34,59"
              stroke="#FFFFFF"
              strokeOpacity="0.4"
              strokeWidth="1.35"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              className="splash-chevron-main"
              d="M44,38 L60,50 L44,62"
              stroke="#FFFFFF"
              strokeWidth="1.9"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="splash-text">
          <div className="splash-title">ToBeVPN</div>
          <div className="splash-tagline">{t("splash_tagline")}</div>
          <div className={`splash-status ${slowStart ? "splash-status--visible" : ""}`}>
            {t("pairing_waiting")}
          </div>
        </div>
      </div>
    </div>
  );
}

const SPLASH_HOLD_MS = 1600;
const SPLASH_EXIT_MS = 400;
