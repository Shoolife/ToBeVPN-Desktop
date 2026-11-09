import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnimatedDialogClose } from "./useAnimatedDialogClose";
import "./WhatsNewDialog.css";
import "../screens/RouterScreen.css";

/**
 * A centred window over the screen, as the app's other dialogs (What's new,
 * demo login): blurred backdrop, rise in, fade out. While `locked` it cannot
 * be closed.
 */
export default function CenterDialog({
  label,
  locked = false,
  onClose,
  children,
}: {
  label: string;
  locked?: boolean;
  onClose: () => void;
  children: (close: (after?: () => void) => void) => ReactNode;
}) {
  const { closing, requestClose } = useAnimatedDialogClose(onClose);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const close = (after?: () => void) =>
    requestClose(after ? () => {
      onClose();
      after();
    } : undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !lockedRef.current) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return createPortal(
    <div
      className={`whats-new-overlay ${closing ? "whats-new-overlay--closing" : ""}`}
      onClick={() => {
        if (!locked) close();
      }}
    >
      <div
        className="whats-new-dialog router-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {children(close)}
      </div>
    </div>,
    document.getElementById("overlay-root") ?? document.body,
  );
}
