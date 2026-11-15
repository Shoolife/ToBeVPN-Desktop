import { useEffect, useRef, useState, type CSSProperties } from "react";

/** One turn of the refresh icon (TopbarRefreshButton spins 0.9 s per turn). */
export const REFRESH_TURN_MS = 900;
const FADE_OUT_MS = 220;
const GAP_MS = 40;
const FADE_IN_MS = 420;
const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * Waits for the end of the refresh icon's current turn, at least one: a
 * result shown then appears as the icon comes to rest, not mid-turn. Every
 * screen with a refresh button waits this way, as on the phone.
 */
export async function awaitWholeRefreshTurns(startedAt: number | null): Promise<void> {
  if (startedAt === null) return;
  const elapsed = performance.now() - startedAt;
  const turns = Math.max(1, Math.ceil(elapsed / REFRESH_TURN_MS));
  const left = turns * REFRESH_TURN_MS - elapsed;
  if (left > 0) await new Promise((resolve) => window.setTimeout(resolve, left));
}

/**
 * The swap between a screen's content and its refresh placeholders, as on
 * the phone: the old view fades out quickly, then the new one fades in
 * slowly and evenly, never an instant switch. `refreshing` is what to show
 * (it lags the real state by the fade); `style` goes on the swapping part.
 */
export function useRefreshSwap(refreshing: boolean): { refreshing: boolean; style: CSSProperties } {
  const [shown, setShown] = useState(refreshing);
  const [visible, setVisible] = useState(true);
  const shownRef = useRef(refreshing);

  useEffect(() => {
    if (shownRef.current === refreshing) {
      setVisible(true);
      return;
    }
    setVisible(false);
    let frame = 0;
    const timer = window.setTimeout(() => {
      shownRef.current = refreshing;
      setShown(refreshing);
      // The new view starts transparent and fades in from the next frame.
      frame = window.requestAnimationFrame(() => setVisible(true));
    }, FADE_OUT_MS + GAP_MS);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [refreshing]);

  return {
    refreshing: shown,
    style: {
      opacity: visible ? 1 : 0,
      transition: visible
        ? `opacity ${FADE_IN_MS}ms ${EASING}`
        : `opacity ${FADE_OUT_MS}ms ${EASING}`,
    },
  };
}
