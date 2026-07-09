import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t, getSavedLang, saveLang, type Lang, type StringKey } from "../i18n";
import { logout, saveEmail } from "../session/auth";
import { useSession, type UserPlan } from "../session/store";
import { getXrayVersion } from "../session/vpn";
import { formatDateDots } from "../session/dateFormat";
import { loadRoutingSettings, type RoutingMode } from "../session/routingSettings";
import { getSavedTheme, saveTheme, type ThemeMode } from "../session/theme";
import { getUserAvatarUrl, clearUserAvatarCache } from "../session/avatar";
import { getUserProfile, clearUserProfileCache, type TelegramProfile } from "../session/profileName";
import {
  getProfileNameDisplay,
  saveProfileNameDisplay,
  type ProfileNameDisplay,
} from "../session/profileDisplay";
import UpdateCheckRow from "../components/UpdateCheckRow";
import Spinner from "../components/Spinner";
import brandLogo from "../assets/onboarding_logo.svg";
import "./SettingsScreen.css";

const SUPPORT_URL = "https://t.me/meow_meow_vpn?direct";

// Which category the user is currently viewing. The main screen mirrors the
// Android redesign: an account card plus a 2×2 grid of category tiles, with
// theme/language/devices/about pushed onto their own sub-sections. Navigation
// stays inside this component (a local section state) so the surrounding App
// router and every existing settings control keep working unchanged.
type Section = "main" | "personalization" | "advanced" | "support" | "about";

// Name-display modes for the account card, mirroring the Android tiles.
const NAME_MODES: { mode: ProfileNameDisplay; key: StringKey }[] = [
  { mode: "username", key: "profile_display_username" },
  { mode: "name", key: "profile_display_name" },
  { mode: "both", key: "profile_display_both" },
  { mode: "animated", key: "profile_display_animated" },
];

// FAQ entries shown on the Support sub-screen, mirroring the Android list.
const FAQ: { q: StringKey; a: StringKey }[] = [
  { q: "faq_q_connect", a: "faq_a_connect" },
  { q: "faq_q_slow", a: "faq_a_slow" },
  { q: "faq_q_server", a: "faq_a_server" },
  { q: "faq_q_pay", a: "faq_a_pay" },
  { q: "faq_q_activate", a: "faq_a_activate" },
  { q: "faq_q_traffic", a: "faq_a_traffic" },
  { q: "faq_q_devices", a: "faq_a_devices" },
  { q: "faq_q_privacy", a: "faq_a_privacy" },
  { q: "faq_q_platforms", a: "faq_a_platforms" },
  { q: "faq_q_stores", a: "faq_a_stores" },
];

type AccentTier = "green" | "orange" | "red";

function planLabel(plan: UserPlan, displayName?: string | null): string {
  if (displayName && plan !== "EXPIRED") return displayName;
  switch (plan) {
    case "PAID":
      return t("plan_unknown_name");
    case "ADMIN":
      return t("plan_unknown_name");
    case "EXPIRED":
      return t("plan_expired");
    case "FREE_TRIAL":
    default:
      return t("plan_free");
  }
}

// Accent tier drives the account-card glow + plan pill colour, keyed to how
// much of the subscription is left (green plenty / orange low / red almost
// gone or expired), matching the Android AccountCard.
function accentTier(plan: UserPlan, expiresAt: number | null): AccentTier {
  if (plan === "EXPIRED") return "red";
  if (expiresAt !== null) {
    const daysLeft = (expiresAt - Date.now()) / 86_400_000;
    if (daysLeft <= 3) return "red";
    if (daysLeft <= 7) return "orange";
  }
  return "green";
}

function routingModeLabel(mode: RoutingMode): string {
  switch (mode) {
    case "selective":
      return t("routing_mode_selective");
    case "all_vpn":
      return t("routing_mode_all_vpn");
    case "blocked_only":
    default:
      return t("routing_mode_blocked_only");
  }
}

const DIALOG_EXIT_MS = 180;

export default function SettingsScreen({
  onBack,
  onLoggedOut,
  onDevices,
  onRouting,
}: {
  onBack: () => void;
  onLoggedOut: () => void;
  onDevices: () => void;
  onRouting: () => void;
}) {
  const session = useSession();
  const currentLang = getSavedLang();
  const [section, setSection] = useState<Section>("main");
  // During a section change we keep the previous section mounted for one
  // animation cycle so the two cross-fade (old fades/scales out, new fades in),
  // matching the app's screen transitions (e.g. opening the servers list).
  const [prevSection, setPrevSection] = useState<Section | null>(null);
  const sectionTimerRef = useRef<number | null>(null);

  const goToSection = (next: Section) => {
    if (next === section) return;
    if (sectionTimerRef.current !== null) window.clearTimeout(sectionTimerRef.current);
    setPrevSection(section);
    setSection(next);
    sectionTimerRef.current = window.setTimeout(() => {
      setPrevSection(null);
      sectionTimerRef.current = null;
    }, 300);
  };
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getSavedTheme());
  const [pendingLang, setPendingLang] = useState<Lang | null>(null);
  const [languageDialogClosing, setLanguageDialogClosing] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutClosing, setLogoutClosing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [xrayVersion, setXrayVersion] = useState("Xray-core ...");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [profile, setProfile] = useState<TelegramProfile>({ name: null, username: null });
  const [nameMode, setNameMode] = useState<ProfileNameDisplay>(() => getProfileNameDisplay());
  const [routingMode, setRoutingMode] = useState<RoutingMode>(
    () => loadRoutingSettings().mode,
  );

  // Email editing
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const languageDialogTimerRef = useRef<number | null>(null);
  const logoutDialogTimerRef = useRef<number | null>(null);

  // Support FAQ scroll affordances (fading edges + ↑/↓ arrows), mirroring the
  // Android SupportScreen.
  const faqScrollRef = useRef<HTMLDivElement>(null);
  const [faqTopFade, setFaqTopFade] = useState(false);
  const [faqBottomFade, setFaqBottomFade] = useState(false);

  const updateFaqFades = () => {
    const el = faqScrollRef.current;
    if (!el) return;
    setFaqTopFade(el.scrollTop > 1);
    setFaqBottomFade(el.scrollTop < el.scrollHeight - el.clientHeight - 1);
  };

  // Pull an expanded card so its middle lines up with the viewport middle (as
  // far as the ends allow) — the "centre the touched one" behaviour, vertical.
  const centerFaqItem = (item: HTMLElement) => {
    const container = faqScrollRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    const itemCenterInContent =
      iRect.top - cRect.top + container.scrollTop + iRect.height / 2;
    const target = itemCenterInContent - container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  };

  const clearLanguageDialogTimer = () => {
    if (languageDialogTimerRef.current !== null) {
      window.clearTimeout(languageDialogTimerRef.current);
      languageDialogTimerRef.current = null;
    }
  };

  const clearLogoutDialogTimer = () => {
    if (logoutDialogTimerRef.current !== null) {
      window.clearTimeout(logoutDialogTimerRef.current);
      logoutDialogTimerRef.current = null;
    }
  };

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
      clearLanguageDialogTimer();
      setLanguageDialogClosing(false);
      setPendingLang(lang);
    }
  };

  const closeLanguageDialog = () => {
    if (!pendingLang || languageDialogClosing) return;
    clearLanguageDialogTimer();
    setLanguageDialogClosing(true);
    languageDialogTimerRef.current = window.setTimeout(() => {
      setPendingLang(null);
      setLanguageDialogClosing(false);
      languageDialogTimerRef.current = null;
    }, DIALOG_EXIT_MS);
  };

  const handleRestart = () => {
    if (pendingLang) {
      clearLanguageDialogTimer();
      saveLang(pendingLang);
      window.location.reload();
    }
  };

  const handleThemeClick = (theme: ThemeMode) => {
    if (theme !== themeMode) setThemeMode(saveTheme(theme));
  };

  const handleNameModeClick = (mode: ProfileNameDisplay) => {
    if (mode !== nameMode) setNameMode(saveProfileNameDisplay(mode));
  };

  const openLogoutDialog = () => {
    clearLogoutDialogTimer();
    setLogoutClosing(false);
    setLogoutOpen(true);
  };

  const closeLogoutDialog = () => {
    if (!logoutOpen || logoutClosing || loggingOut) return;
    clearLogoutDialogTimer();
    setLogoutClosing(true);
    logoutDialogTimerRef.current = window.setTimeout(() => {
      setLogoutOpen(false);
      setLogoutClosing(false);
      logoutDialogTimerRef.current = null;
    }, DIALOG_EXIT_MS);
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      clearUserAvatarCache();
      clearUserProfileCache();
      setLoggingOut(false);
      onLoggedOut();
    }
  };

  const openSupport = () => {
    void openUrl(SUPPORT_URL).catch(() => {});
  };

  const openLink = (url: string) => {
    void openUrl(url).catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    getXrayVersion()
      .then((version) => {
        if (!cancelled) setXrayVersion(version || "unknown");
      })
      .catch(() => {
        if (!cancelled) setXrayVersion("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session.isLinked) return;
    let cancelled = false;
    setAvatarLoading(true);
    getUserAvatarUrl().then((url) => {
      if (!cancelled) {
        setAvatarUrl(url);
        setAvatarLoading(false);
      }
    });
    getUserProfile().then((p) => {
      if (!cancelled) setProfile(p);
    });
    return () => {
      cancelled = true;
    };
  }, [session.isLinked]);

  useEffect(() => {
    const refreshRoutingMode = () => setRoutingMode(loadRoutingSettings().mode);
    refreshRoutingMode();
    window.addEventListener("focus", refreshRoutingMode);
    return () => window.removeEventListener("focus", refreshRoutingMode);
  }, []);

  useEffect(() => clearLanguageDialogTimer, []);
  useEffect(() => clearLogoutDialogTimer, []);

  // Recompute the FAQ fade edges whenever we enter the Support section (after
  // its list has laid out).
  useEffect(() => {
    if (section !== "support") return;
    const id = requestAnimationFrame(updateFaqFades);
    return () => cancelAnimationFrame(id);
  }, [section]);

  const tier = accentTier(session.userPlan, session.planExpiresAt);
  const showExpires =
    (session.userPlan === "PAID" || session.userPlan === "ADMIN") &&
    session.planExpiresAt !== null;

  // Text under the avatar, resolved from the profile + chosen display mode.
  const fullName = profile.name;
  const handle = profile.username ? `@${profile.username}` : null;
  const idLabel = session.telegramId !== null ? `ID ${session.telegramId}` : null;
  const primaryName =
    nameMode === "username"
      ? handle ?? fullName ?? idLabel
      : fullName ?? handle ?? idLabel;
  const bothHandle = nameMode === "both" && fullName && handle ? handle : null;
  const cycleLabels = ([fullName, handle].filter((x): x is string => !!x));
  const animatedLabels = cycleLabels.length > 0 ? cycleLabels : idLabel ? [idLabel] : [];

  // Top bar: back on the left mirrors the sign-out icon on the right (main
  // section only). Sub-sections use back to return to the tile grid.
  const topTitle =
    section === "personalization"
      ? t("settings_personalization")
      : section === "advanced"
        ? t("settings_advanced")
        : section === "support"
          ? t("settings_support")
          : section === "about"
            ? t("about")
            : t("settings");

  const handleTopBack = () => {
    if (section === "main") onBack();
    else goToSection("main");
  };

  return (
    <div className="settings-root">
      {/* Top bar */}
      <div className="settings-topbar">
        <button className="settings-topbar__back" onClick={handleTopBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="settings-topbar__title">{topTitle}</span>
        {section === "main" && session.isLinked ? (
          <button
            className="settings-topbar__logout"
            onClick={openLogoutDialog}
            aria-label={t("logout")}
            title={t("logout")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        ) : (
          <div style={{ width: 40 }} />
        )}
      </div>

      <div className="settings-viewport">
        {([prevSection, section] as (Section | null)[]).map((s, idx) => {
          if (s === null) return null;
          const animClass =
            prevSection === null
              ? ""
              : idx === 1
                ? "settings-layer--enter"
                : "settings-layer--exit";
          return (
            <div key={`${s}-${idx}`} className={`settings-layer ${animClass}`}>
              <div className={`settings-content ${s === "support" ? "settings-content--support" : ""}`}>
        {s === "main" && (
          <>
            {/* Account card — avatar centred in the left half, plan/ID/expiry
                block centred in the right half, mirroring the Android card. */}
            <div className={`settings-account settings-account--${tier}`}>
              <div className="settings-account__left">
                <div className="settings-account__avatar">
                  <div className="settings-account__avatar-inner">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" className="settings-account__avatar-img" />
                    ) : avatarLoading ? (
                      <Spinner size={40} thickness={3} />
                    ) : (
                      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="8" r="4" />
                        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
                      </svg>
                    )}
                  </div>
                </div>
                {nameMode === "animated"
                  ? animatedLabels.length > 0 && (
                      <CyclingName
                        labels={animatedLabels}
                        className="settings-account__name"
                      />
                    )
                  : primaryName && (
                      <>
                        <span className="settings-account__name">{primaryName}</span>
                        {bothHandle && (
                          <span className="settings-account__handle">{bothHandle}</span>
                        )}
                      </>
                    )}
              </div>
              <div className="settings-account__right">
                <span className={`settings-account__plan settings-account__plan--${tier}`}>
                  {planLabel(session.userPlan, session.planDisplayName)}
                </span>
                <span className="settings-account__id">
                  ID {session.telegramId !== null ? String(session.telegramId) : "—"}
                </span>
                {showExpires && (
                  <span className="settings-account__expires">
                    {t("expires")} {formatDateDots(session.planExpiresAt!)}
                  </span>
                )}
                {session.userPlan === "EXPIRED" && (
                  <span className="settings-account__renew">{t("renew_in_bot")}</span>
                )}
              </div>
            </div>

            {/* 2×2 category grid */}
            <div className="settings-tiles">
              <CategoryTile
                accent="#8B7CF6"
                label={t("settings_personalization")}
                desc={t("settings_personalization_desc")}
                onClick={() => goToSection("personalization")}
                iconPath="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67 0 1.38-1.12 2.5-2.5 2.5zm-6.5-9c-.83 0-1.5-.67-1.5-1.5S4.67 10 5.5 10s1.5.67 1.5 1.5S6.33 13 5.5 13zm3-4C7.67 9 7 8.33 7 7.5S7.67 6 8.5 6s1.5.67 1.5 1.5S9.33 9 8.5 9zm7 0c-.83 0-1.5-.67-1.5-1.5S14.67 6 15.5 6s1.5.67 1.5 1.5S16.33 9 15.5 9zm3 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
                iconEvenOdd
              />
              <CategoryTile
                accent="#2196F3"
                label={t("settings_advanced")}
                desc={t("settings_advanced_desc")}
                onClick={() => goToSection("advanced")}
                iconPath="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"
              />
              <CategoryTile
                accent="#4CAF50"
                label={t("settings_support")}
                desc={t("settings_support_desc")}
                onClick={() => goToSection("support")}
                iconPath="M21 12.22C21 6.73 16.74 3 12 3c-4.69 0-9 3.65-9 9.28-.6.34-1 .98-1 1.72v2c0 1.1.9 2 2 2h1v-6.1c0-3.87 3.13-7 7-7s7 3.13 7 7V19h-8v2h8c1.1 0 2-.9 2-2v-1.22c.59-.31 1-.92 1-1.64v-2.3c0-.7-.41-1.31-1-1.62zM9 14c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm6 0c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm3-2.97C17.52 8.18 15.04 6 12.05 6c-3.03 0-6.29 2.51-6.03 6.45 2.47-1.01 4.33-3.21 4.86-5.89 1.31 2.63 4 4.44 7.12 4.47z"
              />
              <CategoryTile
                accent="#FF9800"
                label={t("about")}
                desc={t("settings_about_desc")}
                onClick={() => goToSection("about")}
                iconPath="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"
                iconEvenOdd
              />
            </div>
          </>
        )}

        {s === "personalization" && (
          <>
            {/* Language */}
            <div className="settings-card">
              <SectionTitle
                accent="#2196F3"
                title={t("language")}
                iconPath="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"
              />
              <div className="settings-chips">
                <button
                  className={`settings-chip ${currentLang === "en" ? "settings-chip--active" : ""}`}
                  onClick={() => handleLangClick("en")}
                >
                  🇬🇧 {t("language_english")}
                </button>
                <button
                  className={`settings-chip ${currentLang === "ru" ? "settings-chip--active" : ""}`}
                  onClick={() => handleLangClick("ru")}
                >
                  🇷🇺 {t("language_russian")}
                </button>
              </div>
            </div>

            {/* Theme */}
            <div className="settings-card">
              <SectionTitle
                accent="#8B7CF6"
                title={t("theme")}
                iconEvenOdd
                iconPath="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67 0 1.38-1.12 2.5-2.5 2.5zm-6.5-9c-.83 0-1.5-.67-1.5-1.5S4.67 10 5.5 10s1.5.67 1.5 1.5S6.33 13 5.5 13zm3-4C7.67 9 7 8.33 7 7.5S7.67 6 8.5 6s1.5.67 1.5 1.5S9.33 9 8.5 9zm7 0c-.83 0-1.5-.67-1.5-1.5S14.67 6 15.5 6s1.5.67 1.5 1.5S16.33 9 15.5 9zm3 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
              />
              <div className="theme-tiles">
                <ThemeTile
                  variant="dark"
                  label={t("theme_dark")}
                  selected={themeMode === "dark"}
                  onClick={() => handleThemeClick("dark")}
                />
                <ThemeTile
                  variant="light"
                  label={t("theme_light")}
                  selected={themeMode === "light"}
                  onClick={() => handleThemeClick("light")}
                />
              </div>
            </div>

            {/* Name under the avatar */}
            {session.isLinked && (
              <div className="settings-card">
                <SectionTitle
                  accent="#4CAF50"
                  title={t("settings_profile_display")}
                  iconPath="M20 7h-4V5.33C16 4.6 15.4 4 14.67 4H9.33C8.6 4 8 4.6 8 5.33V7H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm-6 0h-4V6h4v1z"
                />
                <div className="label-tiles">
                  {NAME_MODES.map((m) => (
                    <LabelTile
                      key={m.mode}
                      label={t(m.key)}
                      selected={nameMode === m.mode}
                      onClick={() => handleNameModeClick(m.mode)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {s === "advanced" && (
          <>
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

            {/* Routing card */}
            <div className="settings-card settings-card--clickable" onClick={onRouting}>
              <div className="settings-card__row">
                <div className="settings-card__col">
                  <div className="settings-card__header">{t("routing_title")}</div>
                  <div className="settings-card__hint">{routingModeLabel(routingMode)}</div>
                </div>
                <div className="settings-card__arrow">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              </div>
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
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {s === "support" && (
          <>
            <div className="support-intro">{t("support_faq_intro")}</div>
            <div className="support-faq-wrap">
              <div
                className="support-faq"
                ref={faqScrollRef}
                onScroll={updateFaqFades}
                style={{
                  WebkitMaskImage: `linear-gradient(to bottom, ${faqTopFade ? "transparent" : "#000"} 0, #000 38px, #000 calc(100% - 38px), ${faqBottomFade ? "transparent" : "#000"} 100%)`,
                  maskImage: `linear-gradient(to bottom, ${faqTopFade ? "transparent" : "#000"} 0, #000 38px, #000 calc(100% - 38px), ${faqBottomFade ? "transparent" : "#000"} 100%)`,
                }}
              >
                {FAQ.map((item) => (
                  <FaqItem
                    key={item.q}
                    question={t(item.q)}
                    answer={t(item.a)}
                    onExpand={centerFaqItem}
                  />
                ))}
              </div>
              <div className={`support-arrow support-arrow--top ${faqTopFade ? "is-visible" : ""}`}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </div>
              <div className={`support-arrow support-arrow--bottom ${faqBottomFade ? "is-visible" : ""}`}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </div>
            <div className="support-actions">
              <button className="support-contact-btn" onClick={openSupport}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 12.22C21 6.73 16.74 3 12 3c-4.69 0-9 3.65-9 9.28-.6.34-1 .98-1 1.72v2c0 1.1.9 2 2 2h1v-6.1c0-3.87 3.13-7 7-7s7 3.13 7 7V19h-8v2h8c1.1 0 2-.9 2-2v-1.22c.59-.31 1-.92 1-1.64v-2.3c0-.7-.41-1.31-1-1.62zM9 14c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm6 0c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm3-2.97C17.52 8.18 15.04 6 12.05 6c-3.03 0-6.29 2.51-6.03 6.45 2.47-1.01 4.33-3.21 4.86-5.89 1.31 2.63 4 4.44 7.12 4.47z" />
                </svg>
                {t("support_contact_button")}
              </button>
            </div>
          </>
        )}

        {s === "about" && (
          <div className="about-zoom">
            <div className="about-header">
              <img src={brandLogo} alt="" className="about-logo" draggable={false} />
              <div className="about-name">ToBeVPN</div>
              <div className="about-slogan">{t("about_slogan")}</div>
            </div>

            <div className="settings-card about-version-card">
              <UpdateCheckRow />
              <div className="settings-info-row">
                <span className="settings-info-row__label about-spec-label">{t("xray")}</span>
                <span className="settings-info-row__value">{xrayVersion}</span>
              </div>
            </div>

            <div className="settings-card settings-card--flush">
              <AboutLinkRow
                label={t("about_news_title")}
                onClick={() => openLink(t("about_news_link"))}
                iconPath="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM19.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"
              />
              <AboutLinkRow
                label={t("about_privacy_title")}
                onClick={() => openLink(t("about_privacy_link"))}
                iconEvenOdd
                iconPath="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 5h2v2h-2V7zm0 4h2v6h-2v-6z"
              />
              <AboutLinkRow
                label={t("about_delete_title")}
                onClick={() => openLink(t("about_delete_link"))}
                iconPath="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
              />
            </div>

            <div className="about-copyright">{t("about_copyright")}</div>
          </div>
        )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Restart dialog */}
      {pendingLang && (
        <div
          className={`dialog-overlay ${languageDialogClosing ? "dialog-overlay--closing" : ""}`}
          onClick={closeLanguageDialog}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog__title">{t("language_restart_title")}</div>
            <div className="dialog__message">{t("language_restart_message")}</div>
            <div className="dialog__actions">
              <button className="dialog__btn dialog__btn--secondary" onClick={closeLanguageDialog}>
                {t("cancel")}
              </button>
              <button className="dialog__btn dialog__btn--primary" onClick={handleRestart}>
                {t("language_restart_button")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logout confirm dialog */}
      {logoutOpen && (
        <div
          className={`dialog-overlay ${logoutClosing ? "dialog-overlay--closing" : ""}`}
          onClick={closeLogoutDialog}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog__title">{t("logout_confirm_title")}</div>
            <div className="dialog__message">{t("logout_confirm_message")}</div>
            <div className="dialog__actions">
              <button
                className="dialog__btn dialog__btn--secondary"
                onClick={closeLogoutDialog}
                disabled={loggingOut}
              >
                {t("cancel")}
              </button>
              <button
                className="dialog__btn dialog__btn--danger"
                onClick={handleLogout}
                disabled={loggingOut}
              >
                {t("logout")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// One line under the avatar that cross-fades between the name and @username
// every few seconds (the "animated" display mode).
function CyclingName({ labels, className }: { labels: string[]; className: string }) {
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(true);
  const joined = labels.join("|");
  useEffect(() => {
    setI(0);
    setVisible(true);
    if (labels.length <= 1) return;
    let swap: number | undefined;
    const cycle = window.setInterval(() => {
      // Fade the current label out (600ms), then swap the text and fade the
      // next one in (900ms) — a fade-through so the two never overlap at half
      // opacity, matching the Android CyclingProfileName.
      setVisible(false);
      swap = window.setTimeout(() => {
        setI((v) => (v + 1) % labels.length);
        setVisible(true);
      }, 600);
    }, 5000);
    return () => {
      window.clearInterval(cycle);
      if (swap) window.clearTimeout(swap);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  const label = labels[i % labels.length] ?? "";
  return (
    <span
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transition: `opacity ${visible ? 900 : 600}ms ease`,
      }}
    >
      {label}
    </span>
  );
}

function LabelTile({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`label-tile ${selected ? "is-selected" : ""}`} onClick={onClick}>
      {selected && (
        <svg className="label-tile__check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}

function SectionTitle({
  accent,
  title,
  iconPath,
  iconEvenOdd = false,
}: {
  accent: string;
  title: string;
  iconPath: string;
  iconEvenOdd?: boolean;
}) {
  return (
    <div className="section-title">
      <div
        className="section-title__icon"
        style={{ color: accent, background: `color-mix(in srgb, ${accent} 18%, transparent)` }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d={iconPath} fillRule={iconEvenOdd ? "evenodd" : "nonzero"} clipRule="evenodd" />
        </svg>
      </div>
      <span className="section-title__text">{title}</span>
    </div>
  );
}

function ThemeTile({
  variant,
  label,
  selected,
  onClick,
}: {
  variant: "dark" | "light";
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`theme-tile ${selected ? "is-selected" : ""}`} onClick={onClick}>
      <div className="theme-tile__swatch">
        <div className={`theme-tile__fill theme-tile__fill--${variant}`} />
        {selected && (
          <div className="theme-tile__check">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        )}
      </div>
      <div className="theme-tile__label">{label}</div>
    </button>
  );
}

function FaqItem({
  question,
  answer,
  onExpand,
}: {
  question: string;
  answer: string;
  onExpand: (item: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Wait for the height animation to settle, then centre the expanded card.
    if (next && ref.current) {
      const el = ref.current;
      window.setTimeout(() => onExpand(el), 260);
    }
  };

  return (
    <div ref={ref} className={`faq-item ${open ? "faq-item--open" : ""}`}>
      <button className="faq-item__q" onClick={toggle}>
        <span className="faq-item__q-text">{question}</span>
        <span className="faq-item__chevron">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      <div className="faq-item__a-wrap">
        <div className="faq-item__a">{answer}</div>
      </div>
    </div>
  );
}

function AboutLinkRow({
  label,
  onClick,
  iconPath,
  iconEvenOdd = false,
}: {
  label: string;
  onClick: () => void;
  iconPath: string;
  iconEvenOdd?: boolean;
}) {
  return (
    <button className="about-link" onClick={onClick}>
      <svg className="about-link__icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
        <path d={iconPath} fillRule={iconEvenOdd ? "evenodd" : "nonzero"} clipRule="evenodd" />
      </svg>
      <span className="about-link__label">{label}</span>
      <svg className="about-link__chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}

function CategoryTile({
  accent,
  label,
  desc,
  onClick,
  iconPath,
  iconEvenOdd = false,
}: {
  accent: string;
  label: string;
  desc: string;
  onClick: () => void;
  iconPath: string;
  iconEvenOdd?: boolean;
}) {
  return (
    <button className="settings-tile" onClick={onClick}>
      <div className="settings-tile__top">
        <div
          className="settings-tile__icon"
          style={{
            color: accent,
            background: `color-mix(in srgb, ${accent} 18%, transparent)`,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d={iconPath} fillRule={iconEvenOdd ? "evenodd" : "nonzero"} clipRule="evenodd" />
          </svg>
        </div>
        <div className="settings-tile__chevron">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
      <div className="settings-tile__label">{label}</div>
      <div className="settings-tile__desc">{desc}</div>
    </button>
  );
}
