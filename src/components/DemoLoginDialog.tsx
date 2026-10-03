import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { useAnimatedDialogClose } from "./useAnimatedDialogClose";
import "./WhatsNewDialog.css";
import "./DemoLoginDialog.css";

export default function DemoLoginDialog({
  onDismiss,
  onSubmit,
}: {
  onDismiss: () => void;
  onSubmit: (pin: string) => boolean;
}) {
  const { closing, requestClose } = useAnimatedDialogClose(onDismiss);
  const [pin, setPin] = useState("");
  const [showError, setShowError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setShowError(!onSubmit(pin));
  };

  const target = document.getElementById("overlay-root") ?? document.body;

  return createPortal(
    <div
      className={`whats-new-overlay ${closing ? "whats-new-overlay--closing" : ""}`}
      onClick={() => requestClose()}
    >
      <form
        className="whats-new-dialog demo-login"
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-login-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="demo-login-title" className="whats-new-dialog__title">
          {t("demo_login_title")}
        </h2>
        <p className="demo-login__description">{t("demo_login_description")}</p>
        <input
          ref={inputRef}
          className={`demo-login__input ${showError ? "demo-login__input--error" : ""}`}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label={t("demo_login_pin_label")}
          placeholder={t("demo_login_pin_label")}
          value={pin}
          onChange={(event) => {
            setPin(event.target.value);
            setShowError(false);
          }}
        />
        {showError && <div className="demo-login__error">{t("demo_login_error")}</div>}
        <button type="submit" className="whats-new-dialog__done">
          {t("demo_login_confirm")}
        </button>
        <button type="button" className="demo-login__cancel" onClick={() => requestClose()}>
          {t("demo_login_cancel")}
        </button>
      </form>
    </div>,
    target,
  );
}
