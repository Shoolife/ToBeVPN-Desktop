import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { detectRouter, ROUTER_SECTION_AVAILABLE } from "../session/router";

const OFFERED_KEY = "tobevpn_keenetic_offered";
/** The settings dialogs' fade-out (SettingsScreen.css). */
const DIALOG_EXIT_MS = 150;

function alreadyOffered(): boolean {
  try {
    return localStorage.getItem(OFFERED_KEY) !== null;
  } catch {
    // Without storage the offer could come back at every start: not shown.
    return true;
  }
}

function markOffered() {
  try {
    localStorage.setItem(OFFERED_KEY, "1");
  } catch {
    // Nothing to remember it in; it is closed for this run anyway.
  }
}

/**
 * The one-time invitation for Keenetic owners: on Home, when this network's
 * router is a Keenetic, it offers to open the router screen and test Keenetic
 * support. Shown once, whatever the answer.
 */
export default function KeeneticOfferDialog({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!active || open || !ROUTER_SECTION_AVAILABLE || alreadyOffered()) return;
    let cancelled = false;
    // A moment after Home appears, not over its first frames.
    const timer = window.setTimeout(() => {
      void detectRouter().then((info) => {
        if (!cancelled && info.firmware === "keenetic" && !alreadyOffered()) setOpen(true);
      });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, open]);

  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const close = (after?: () => void) => {
    if (closing) return;
    markOffered();
    setClosing(true);
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      timer.current = null;
      after?.();
    }, DIALOG_EXIT_MS);
  };

  if (!open) return null;
  // The logout window's look: centred title and text, two equal buttons.
  return createPortal(
    <div className={`dialog-overlay ${closing ? "dialog-overlay--closing" : ""}`} onClick={() => close()}>
      <div
        className="dialog dialog--logout"
        role="dialog"
        aria-modal="true"
        aria-label={t("keenetic_offer_title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__title">{t("keenetic_offer_title")}</div>
        <div className="dialog__message">{t("keenetic_offer_text")}</div>
        <div className="dialog__actions dialog__actions--logout">
          <button type="button" className="dialog__btn dialog__btn--secondary" onClick={() => close()}>
            {t("keenetic_offer_later")}
          </button>
          <button type="button" className="dialog__btn dialog__btn--primary" onClick={() => close(onOpen)}>
            {t("keenetic_offer_open")}
          </button>
        </div>
      </div>
    </div>,
    document.getElementById("overlay-root") ?? document.body,
  );
}
