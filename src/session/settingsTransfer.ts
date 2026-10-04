// "Export and import" of local settings, ported from the Android client
// (SettingsTransferManager). The file format is shared with the phone:
// language, theme and display settings move between devices both ways.
// Site routing is desktop-only and goes into its own `desktopRouting` field,
// which the phone ignores; the phone's per-app routing does not apply here.
import { invoke } from "@tauri-apps/api/core";
import { getSavedLang, saveLang, type Lang } from "../i18n";
import { getSavedTheme, saveTheme, type ThemeMode } from "./theme";
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  INTERFACE_SCALE_MAX,
  INTERFACE_SCALE_MIN,
  getSavedBoldText,
  getSavedFontScale,
  getSavedInterfaceScale,
  getSavedOutlinedText,
  saveBoldText,
  saveFontScale,
  saveInterfaceScale,
  saveOutlinedText,
} from "./interfaceScale";
import {
  loadRoutingSettings,
  saveRoutingSettings,
  type RoutingMode,
  type RoutingSettings,
} from "./routingSettings";
import { reapplyRoutingSettings } from "./vpnState";

const FORMAT = "tobevpn-settings";
const VERSION = 1;
export const MAX_SETTINGS_FILE_BYTES = 256 * 1024;
const ROUTING_MODES: readonly RoutingMode[] = ["blocked_only", "selective", "all_vpn"];

export interface SettingsTransferSelection {
  language: boolean;
  theme: boolean;
  display: boolean;
  routing: boolean;
}

export const SETTINGS_TRANSFER_SECTION_COUNT = 4;

interface PortableDisplaySettings {
  interfaceScale: number;
  fontScale: number;
  boldText: boolean;
  outlinedText: boolean;
}

export interface SettingsBackupDocument {
  format: string;
  formatVersion: number;
  createdAtMillis: number;
  language?: Lang;
  /** Phone values: SYSTEM, DARK or LIGHT. */
  theme?: "SYSTEM" | "DARK" | "LIGHT";
  display?: PortableDisplaySettings;
  /** Written by the phone; not applicable on desktop. */
  appRouting?: { mode: string; packages: string[] };
  desktopRouting?: RoutingSettings;
}

export interface SettingsImportPreview {
  document: SettingsBackupDocument;
  available: SettingsTransferSelection;
}

export function countSelected(selection: SettingsTransferSelection): number {
  return [selection.language, selection.theme, selection.display, selection.routing].filter(Boolean).length;
}

export function buildSettingsDocument(selection: SettingsTransferSelection): SettingsBackupDocument {
  const document: SettingsBackupDocument = {
    format: FORMAT,
    formatVersion: VERSION,
    createdAtMillis: Date.now(),
  };
  if (selection.language) document.language = getSavedLang();
  if (selection.theme) document.theme = getSavedTheme() === "light" ? "LIGHT" : "DARK";
  if (selection.display) {
    document.display = {
      interfaceScale: getSavedInterfaceScale(),
      fontScale: getSavedFontScale(),
      boldText: getSavedBoldText(),
      outlinedText: getSavedOutlinedText(),
    };
  }
  if (selection.routing) document.desktopRouting = loadRoutingSettings();
  return document;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min - 1e-6 && value <= max + 1e-6;
}

/** Validates a file the same way the phone does; throws on anything unexpected. */
export function decodeSettingsDocument(raw: string): SettingsBackupDocument {
  if (new TextEncoder().encode(raw).length > MAX_SETTINGS_FILE_BYTES) {
    throw new Error("Settings file is too large");
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Not a ToBeVPN settings file");
  const doc = parsed as Record<string, unknown>;
  if (doc.format !== FORMAT) throw new Error("Not a ToBeVPN settings file");
  if (doc.formatVersion !== VERSION) throw new Error("Unsupported settings file version");

  const result: SettingsBackupDocument = {
    format: FORMAT,
    formatVersion: VERSION,
    createdAtMillis: typeof doc.createdAtMillis === "number" ? doc.createdAtMillis : 0,
  };
  if (doc.language !== undefined && doc.language !== null) {
    if (doc.language !== "ru" && doc.language !== "en") throw new Error("Unsupported language");
    result.language = doc.language;
  }
  if (doc.theme !== undefined && doc.theme !== null) {
    if (doc.theme !== "SYSTEM" && doc.theme !== "DARK" && doc.theme !== "LIGHT") {
      throw new Error("Unsupported theme");
    }
    result.theme = doc.theme;
  }
  if (doc.display !== undefined && doc.display !== null) {
    const display = doc.display as Record<string, unknown>;
    if (
      !inRange(display.interfaceScale, INTERFACE_SCALE_MIN, INTERFACE_SCALE_MAX) ||
      !inRange(display.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX)
    ) {
      throw new Error("Invalid display settings");
    }
    result.display = {
      interfaceScale: display.interfaceScale,
      fontScale: display.fontScale,
      boldText: display.boldText === true,
      outlinedText: display.outlinedText === true,
    };
  }
  if (doc.appRouting !== undefined && doc.appRouting !== null) {
    const routing = doc.appRouting as Record<string, unknown>;
    if (typeof routing.mode !== "string" || !isStringList(routing.packages)) {
      throw new Error("Invalid app routing settings");
    }
    result.appRouting = { mode: routing.mode, packages: routing.packages };
  }
  if (doc.desktopRouting !== undefined && doc.desktopRouting !== null) {
    const routing = doc.desktopRouting as Record<string, unknown>;
    if (
      !ROUTING_MODES.includes(routing.mode as RoutingMode) ||
      !isStringList(routing.selectedServiceDomains) ||
      !isStringList(routing.excludedServiceDomains) ||
      !isStringList(routing.directDomains) ||
      !isStringList(routing.proxyDomains)
    ) {
      throw new Error("Invalid routing settings");
    }
    result.desktopRouting = {
      mode: routing.mode as RoutingMode,
      selectAllServices: routing.selectAllServices === true,
      selectedServiceDomains: routing.selectedServiceDomains,
      excludedServiceDomains: routing.excludedServiceDomains,
      directDomains: routing.directDomains,
      proxyDomains: routing.proxyDomains,
    };
  }
  if (
    result.language === undefined && result.theme === undefined &&
    result.display === undefined && result.appRouting === undefined &&
    result.desktopRouting === undefined
  ) {
    throw new Error("Settings file is empty");
  }
  return result;
}

export function previewSettingsDocument(document: SettingsBackupDocument): SettingsImportPreview {
  return {
    document,
    available: {
      language: document.language !== undefined,
      theme: document.theme !== undefined,
      display: document.display !== undefined,
      routing: document.desktopRouting !== undefined,
    },
  };
}

export async function exportSettingsFile(selection: SettingsTransferSelection): Promise<string> {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fileName = `ToBeVPN-settings-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const contents = JSON.stringify(buildSettingsDocument(selection), null, 2);
  return invoke<string>("export_settings_file", { contents, fileName });
}

function themeFromDocument(value: NonNullable<SettingsBackupDocument["theme"]>): ThemeMode {
  if (value === "LIGHT") return "light";
  if (value === "DARK") return "dark";
  // Desktop has no "follow the system" option; take the system's current look.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Saves the selected parts. Returns true when the window must reload to show
 * them (language, theme and scale are read at startup).
 */
export async function applySettingsImport(
  preview: SettingsImportPreview,
  selection: SettingsTransferSelection,
): Promise<boolean> {
  const { document } = preview;
  let reload = false;
  if (selection.theme && document.theme) {
    saveTheme(themeFromDocument(document.theme));
    reload = true;
  }
  if (selection.display && document.display) {
    saveInterfaceScale(document.display.interfaceScale);
    saveFontScale(document.display.fontScale);
    saveBoldText(document.display.boldText);
    saveOutlinedText(document.display.outlinedText);
    reload = true;
  }
  if (selection.routing && document.desktopRouting) {
    saveRoutingSettings(document.desktopRouting);
    await reapplyRoutingSettings();
  }
  if (selection.language && document.language) {
    saveLang(document.language);
    reload = true;
  }
  return reload;
}
