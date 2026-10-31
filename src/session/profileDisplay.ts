import { useSyncExternalStore } from "react";
import { useSession } from "./store";

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

// Admins only: hide personal data (Telegram photo, name, ID, email, referral
// link and names, device names) for screenshots and screen sharing.
// Separate from the name mode above.
const HIDDEN_KEY = "tobevpn_profile_hidden";
const hiddenListeners = new Set<() => void>();

export const PERSONAL_DATA_MASK = "••••••";

export function getProfileHidden(): boolean {
  return localStorage.getItem(HIDDEN_KEY) === "1";
}

export function saveProfileHidden(hidden: boolean): boolean {
  if (hidden) localStorage.setItem(HIDDEN_KEY, "1");
  else localStorage.removeItem(HIDDEN_KEY);
  hiddenListeners.forEach((listener) => listener());
  return hidden;
}

function subscribeProfileHidden(listener: () => void): () => void {
  hiddenListeners.add(listener);
  return () => hiddenListeners.delete(listener);
}

// Whether personal data is hidden right now. Hiding is an admin privilege; a
// stored value outlives the role, so it only applies while the account is an
// admin.
export function usePersonalDataHidden(): boolean {
  const isAdmin = useSession().isAdminProfile;
  const saved = useSyncExternalStore(subscribeProfileHidden, getProfileHidden);
  return saved && isAdmin;
}
