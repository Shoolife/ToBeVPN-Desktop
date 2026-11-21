import { useEffect, useState } from "react";
import CenterDialog from "./CenterDialog";
import { t } from "../i18n";
import { detectRouter, ROUTER_SECTION_AVAILABLE } from "../session/router";

const OFFERED_KEY = "tobevpn_keenetic_offered";

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

  if (!open) return null;
  return (
    <CenterDialog
      label={t("keenetic_offer_title")}
      onClose={() => {
        markOffered();
        setOpen(false);
      }}
    >
      {(close) => (
        <div className="router-uninstall-sheet keenetic-offer">
          <h2 className="whats-new-dialog__title">{t("keenetic_offer_title")}</h2>
          <p className="router-uninstall-sheet__text">{t("keenetic_offer_text")}</p>
          <div className="router-bottom__buttons">
            <button type="button" className="router-button" onClick={() => close()}>
              {t("keenetic_offer_later")}
            </button>
            <button type="button" className="router-button router-button--primary" onClick={() => close(onOpen)}>
              {t("keenetic_offer_open")}
            </button>
          </div>
        </div>
      )}
    </CenterDialog>
  );
}
