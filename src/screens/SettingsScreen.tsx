import { useRef, useState } from "react";
import { t, getSavedLang, saveLang, type Lang } from "../i18n";
import { logout, saveEmail } from "../session/auth";
import { useSession, type UserPlan } from "../session/store";
import UpdateCheckRow from "../components/UpdateCheckRow";
import "./SettingsScreen.css";

function planLabel(plan: UserPlan): string {
  switch (plan) {
    case "PAID":
      return t("plan_standard");
    case "ADMIN":
      return t("plan_admin");
    case "EXPIRED":
      return t("plan_expired");
    case "FREE_TRIAL":
    default:
      return t("plan_free");
  }
}

function planValueClass(plan: UserPlan): string {
  switch (plan) {
    case "PAID":
    case "ADMIN":
      return "settings-info-row__value settings-info-row__value--green";
    case "EXPIRED":
      return "settings-info-row__value settings-info-row__value--red";
    case "FREE_TRIAL":
    default:
      return "settings-info-row__value settings-info-row__value--orange";
  }
}

function formatExpiresDate(epochMillis: number): string {
  const d = new Date(epochMillis);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export default function SettingsScreen({
  onBack,
  onLoggedOut,
  onDevices,
}: {
  onBack: () => void;
  onLoggedOut: () => void;
  onDevices: () => void;
}) {
  const session = useSession();
  const currentLang = getSavedLang();
  const [pendingLang, setPendingLang] = useState<Lang | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // Email editing
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);

  const handleEditEmail = () => {
    setEmailDraft(session.email ?? "");
    setEmailError(null);
    setEditingEmail(true);
    requestAnimationFrame(() => emailInputRef.current?.focus());
  };

  const handleSaveEmail = async () => {
    const trimmed = emailDraft.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError(t("email_error"));
      return;
    }
    setEmailSaving(true);
    setEmailError(null);
    try {
      await saveEmail(trimmed);
      setEditingEmail(false);
    } catch {
      setEmailError(t("email_error"));
    } finally {
      setEmailSaving(false);
    }
  };

  const handleLangClick = (lang: Lang) => {
    if (lang !== currentLang) {
      setPendingLang(lang);
    }
  };

  const handleRestart = () => {
    if (pendingLang) {
      saveLang(pendingLang);
      window.location.reload();
    }
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
      onLoggedOut();
    }
  };

  return (
    <div className="settings-root">
      {/* Top bar */}
      <div className="settings-topbar">
        <button className="settings-topbar__back" onClick={onBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span className="settings-topbar__title">{t("settings")}</span>
        <div style={{ width: 34 }} />
      </div>

      <div className="settings-content">
        {/* Account card */}
        <div className="settings-card">
          <div className="settings-card__header">{t("account")}</div>
          <div className="settings-info-row">
            <span className="settings-info-row__label">{t("telegram_id")}</span>
            <span className="settings-info-row__value">
              {session.telegramId !== null ? String(session.telegramId) : "—"}
            </span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-row__label">{t("plan")}</span>
            <span className={planValueClass(session.userPlan)}>
              {planLabel(session.userPlan)}
            </span>
          </div>
          {session.userPlan === "PAID" && session.planExpiresAt !== null && (
            <div className="settings-info-row">
              <span className="settings-info-row__label">{t("expires")}</span>
              <span className="settings-info-row__value">
                {formatExpiresDate(session.planExpiresAt)}
              </span>
            </div>
          )}
          {session.userPlan === "ADMIN" && (
            <div className="settings-info-row">
              <span className="settings-info-row__label">{t("traffic")}</span>
              <span className="settings-info-row__value">{t("plan_unlimited_access")}</span>
            </div>
          )}
          {session.userPlan === "EXPIRED" && (
            <div className="settings-card__renew-hint">{t("renew_in_bot")}</div>
          )}
        </div>

        {/* Email card */}
        <div className="settings-card">
          <div className="settings-card__header">{t("email_title")}</div>
          {editingEmail ? (
            <div className="settings-email-edit">
              <input
                ref={emailInputRef}
                className="settings-email-edit__input"
                type="email"
                placeholder={t("email_placeholder")}
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveEmail();
                  if (e.key === "Escape") setEditingEmail(false);
                }}
                disabled={emailSaving}
              />
              {emailError && <div className="settings-email-edit__error">{emailError}</div>}
              <div className="settings-email-edit__actions">
                <button
                  className="dialog__btn dialog__btn--secondary"
                  onClick={() => setEditingEmail(false)}
                  disabled={emailSaving}
                >
                  {t("cancel")}
                </button>
                <button
                  className="dialog__btn dialog__btn--primary"
                  onClick={handleSaveEmail}
                  disabled={emailSaving}
                >
                  {t("email_save")}
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-info-row">
              <span className="settings-info-row__value">
                {session.email ?? t("email_not_set")}
              </span>
              <button className="settings-email-edit-btn" onClick={handleEditEmail}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Devices card */}
        <div className="settings-card settings-card--clickable" onClick={onDevices}>
          <div className="settings-card__row">
            <div className="settings-card__col">
              <div className="settings-card__header">{t("devices_title")}</div>
              <div className="settings-card__hint">{t("devices_manage_hint")}</div>
            </div>
            <div className="settings-card__arrow">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          </div>
        </div>

        {/* Language card */}
        <div className="settings-card">
          <div className="settings-card__header">{t("language")}</div>
          <div className="settings-chips">
            <button
              className={`settings-chip ${currentLang === "en" ? "settings-chip--active" : ""}`}
              onClick={() => handleLangClick("en")}
            >
              {t("language_english")}
            </button>
            <button
              className={`settings-chip ${currentLang === "ru" ? "settings-chip--active" : ""}`}
              onClick={() => handleLangClick("ru")}
            >
              {t("language_russian")}
            </button>
          </div>
        </div>

        {/* About card */}
        <div className="settings-card">
          <div className="settings-card__header">{t("about")}</div>
          <div className="settings-info-row">
            <span className="settings-info-row__label">{t("version")}</span>
            {/* __APP_VERSION__ is injected by Vite from package.json — single
                source of truth so the displayed version always matches the
                tag we ship under. */}
            <span className="settings-info-row__value">{__APP_VERSION__}</span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-row__label">{t("xray")}</span>
            <span className="settings-info-row__value">Xray-core v26.3.27</span>
          </div>
          <UpdateCheckRow />
        </div>

        {/* Logout */}
        <div className="settings-card">
          <button
            className="settings-logout-btn"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {t("logout")}
          </button>
        </div>
      </div>

      {/* Restart dialog */}
      {pendingLang && (
        <div className="dialog-overlay" onClick={() => setPendingLang(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog__title">{t("language_restart_title")}</div>
            <div className="dialog__message">{t("language_restart_message")}</div>
            <div className="dialog__actions">
              <button className="dialog__btn dialog__btn--secondary" onClick={() => setPendingLang(null)}>
                {t("cancel")}
              </button>
              <button className="dialog__btn dialog__btn--primary" onClick={handleRestart}>
                {t("language_restart_button")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
