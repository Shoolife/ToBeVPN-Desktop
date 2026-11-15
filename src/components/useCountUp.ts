import { useEffect, useRef, useState } from "react";

const COUNT_MS = 540;

/**
 * `target` reached by counting, not at once: the shown number moves to a new
 * value over the length of the screen's fade (as on the phone), and ends
 * exactly on it. The first value is shown as it is.
 */
export function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  const shownRef = useRef(target);
  shownRef.current = shown;

  useEffect(() => {
    if (shownRef.current === target) return;
    fromRef.current = shownRef.current;
    const from = fromRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / COUNT_MS);
      // Fast out, slow in, as the fades.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(t >= 1 ? target : from + (target - from) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}
