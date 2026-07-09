// How the name under the account-card avatar is shown. Mirrors the Android
// ProfileNameDisplay enum; persisted in localStorage.
export type ProfileNameDisplay = "username" | "name" | "both" | "animated";

const STORAGE_KEY = "tobevpn_profile_display";
const DEFAULT: ProfileNameDisplay = "animated";

export function getProfileNameDisplay(): ProfileNameDisplay {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "username" || saved === "name" || saved === "both" || saved === "animated") {
    return saved;
  }
  return DEFAULT;
}

export function saveProfileNameDisplay(mode: ProfileNameDisplay): ProfileNameDisplay {
  localStorage.setItem(STORAGE_KEY, mode);
  return mode;
}
