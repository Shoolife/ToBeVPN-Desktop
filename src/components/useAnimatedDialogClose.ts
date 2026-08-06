import { useCallback, useEffect, useRef, useState } from "react";

export const DIALOG_EXIT_ANIMATION_MS = 180;

export function useAnimatedDialogClose(
  onDismiss: () => void,
  exitDurationMs = DIALOG_EXIT_ANIMATION_MS,
) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  const requestClose = useCallback((afterClose?: () => void) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const complete = afterClose ?? onDismiss;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      complete();
    }, exitDurationMs);
  }, [exitDurationMs, onDismiss]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
  }, []);

  return { closing, requestClose };
}
