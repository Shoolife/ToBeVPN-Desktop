export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "tobevpn_theme";
const DEFAULT_THEME: ThemeMode = "dark";

function normalizeTheme(value: unknown): ThemeMode {
  return value === "light" ? "light" : DEFAULT_THEME;
}

export function getSavedTheme(): ThemeMode {
  try {
    return normalizeTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeMode = getSavedTheme()): ThemeMode {
  const normalized = normalizeTheme(theme);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = normalized;
    document.documentElement.style.colorScheme = normalized;
  }
  return normalized;
}

export function saveTheme(theme: ThemeMode): ThemeMode {
  const normalized = normalizeTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // The in-memory DOM theme still changes even if localStorage is unavailable.
  }
  applyTheme(normalized);
  return normalized;
}
