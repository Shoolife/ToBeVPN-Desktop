export const INTERFACE_SCALE_MIN = 0.7;
export const INTERFACE_SCALE_MAX = 1.3;
export const INTERFACE_SCALE_STEP = 0.1;
export const INTERFACE_SCALE_DEFAULT = 1;
export const WINDOW_SCALE_BASE = 0.9;

export const FONT_SCALE_MIN = 0.7;
export const FONT_SCALE_MAX = 1.3;
export const FONT_SCALE_STEP = 0.1;
export const FONT_SCALE_DEFAULT = 1;

export const DESIGN_WINDOW_WIDTH = 494;
export const DESIGN_WINDOW_HEIGHT = 776;

export const WINDOW_RENDER_SCALE_MIN = INTERFACE_SCALE_MIN * WINDOW_SCALE_BASE;
export const WINDOW_RENDER_SCALE_MAX = INTERFACE_SCALE_MAX * WINDOW_SCALE_BASE;

// v2 intentionally starts at the new 1.0 baseline. The first desktop draft
// used 1.0 for the old, larger frame; carrying that experimental value over
// would make the user's requested new default incorrect.
const STORAGE_KEY = "tobevpn_interface_scale_v2";
const FONT_SCALE_STORAGE_KEY = "tobevpn_font_scale_v1";
const BOLD_TEXT_STORAGE_KEY = "tobevpn_bold_text_v1";
const OUTLINED_TEXT_STORAGE_KEY = "tobevpn_outlined_text_v1";

export function normalizeInterfaceScale(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return INTERFACE_SCALE_DEFAULT;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return INTERFACE_SCALE_DEFAULT;

  const clamped = Math.min(INTERFACE_SCALE_MAX, Math.max(INTERFACE_SCALE_MIN, parsed));
  const steps = Math.round((clamped - INTERFACE_SCALE_MIN) / INTERFACE_SCALE_STEP);
  return Number((INTERFACE_SCALE_MIN + steps * INTERFACE_SCALE_STEP).toFixed(1));
}

export function getSavedInterfaceScale(): number {
  try {
    return normalizeInterfaceScale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return INTERFACE_SCALE_DEFAULT;
  }
}

export function saveInterfaceScale(value: number): number {
  const normalized = normalizeInterfaceScale(value);
  try {
    localStorage.setItem(STORAGE_KEY, String(normalized));
  } catch {
    // The setting still applies for the current run when storage is unavailable.
  }
  return normalized;
}

export function interfaceScaleToWindowScale(value: number): number {
  return normalizeInterfaceScale(value) * WINDOW_SCALE_BASE;
}

export function normalizeFontScale(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return FONT_SCALE_DEFAULT;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return FONT_SCALE_DEFAULT;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, parsed));
  const steps = Math.round((clamped - FONT_SCALE_MIN) / FONT_SCALE_STEP);
  return Number((FONT_SCALE_MIN + steps * FONT_SCALE_STEP).toFixed(1));
}

export function getSavedFontScale(): number {
  try {
    return normalizeFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY));
  } catch {
    return FONT_SCALE_DEFAULT;
  }
}

export function saveFontScale(value: number): number {
  const normalized = normalizeFontScale(value);
  try {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(normalized));
  } catch {
    // Keep the in-memory choice when storage is unavailable.
  }
  return normalized;
}

function getSavedBoolean(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function saveBoolean(key: string, value: boolean): boolean {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Keep the in-memory choice when storage is unavailable.
  }
  return value;
}

export const getSavedBoldText = (): boolean => getSavedBoolean(BOLD_TEXT_STORAGE_KEY);
export const saveBoldText = (value: boolean): boolean => saveBoolean(BOLD_TEXT_STORAGE_KEY, value);
export const getSavedOutlinedText = (): boolean => getSavedBoolean(OUTLINED_TEXT_STORAGE_KEY);
export const saveOutlinedText = (value: boolean): boolean =>
  saveBoolean(OUTLINED_TEXT_STORAGE_KEY, value);
