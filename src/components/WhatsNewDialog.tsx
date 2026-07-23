import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { CURRENT_RELEASE_NOTES, type ReleaseHighlight } from "../releaseNotes";
import MaterialIcon from "./MaterialIcon";
import "./WhatsNewDialog.css";

const CLOSE_ANIMATION_MS = 180;

export default function WhatsNewDialog({ onClose }: { onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(
      () => onCloseRef.current(),
      CLOSE_ANIMATION_MS,
    );
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }

      if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled)",
        );
        if (!controls || controls.length === 0) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [requestClose]);

  const target = document.getElementById("overlay-root") ?? document.body;
  const versionLabel = t("whats_new_version").replace(
    "{version}",
    CURRENT_RELEASE_NOTES.version,
  );

  return createPortal(
    <div
      className={`whats-new-overlay ${closing ? "whats-new-overlay--closing" : ""}`}
      onClick={requestClose}
    >
      <section
        ref={dialogRef}
        className="whats-new-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="whats-new-dialog__close"
          onClick={requestClose}
          aria-label={t("whats_new_close")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="whats-new-dialog__hero" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 3 1.15 3.35L16.5 7.5l-3.35 1.15L12 12l-1.15-3.35L7.5 7.5l3.35-1.15L12 3Z" />
            <path d="m18.5 12 .72 2.03 2.03.72-2.03.72-.72 2.03-.72-2.03-2.03-.72 2.03-.72L18.5 12Z" />
            <path d="m6 14 .88 2.62L9.5 17.5l-2.62.88L6 21l-.88-2.62-2.62-.88 2.62-.88L6 14Z" />
          </svg>
        </div>
        <h2 id="whats-new-title" className="whats-new-dialog__title">
          {t("about_whats_new_title")}
        </h2>
        <div className="whats-new-dialog__version">{versionLabel}</div>
        <p className="whats-new-dialog__intro">{t("whats_new_intro")}</p>

        <div className="whats-new-dialog__list">
          {CURRENT_RELEASE_NOTES.highlights.map((highlight) => (
            <Highlight key={highlight.titleKey} highlight={highlight} />
          ))}
        </div>

        <button type="button" className="whats-new-dialog__done" onClick={requestClose}>
          {t("whats_new_done")}
        </button>
      </section>
    </div>,
    target,
  );
}

function Highlight({ highlight }: { highlight: ReleaseHighlight }) {
  return (
    <div className="whats-new-highlight">
      <span className="whats-new-highlight__icon" aria-hidden="true">
        <MaterialIcon name={highlight.icon} size={22} />
      </span>
      <span className="whats-new-highlight__copy">
        <span className="whats-new-highlight__title">{t(highlight.titleKey)}</span>
        <span className="whats-new-highlight__description">
          {t(highlight.descriptionKey)}
        </span>
      </span>
    </div>
  );
}
