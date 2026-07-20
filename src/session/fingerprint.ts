// Device fingerprint provider — mirrors DeviceFingerprintProvider on Android phone/TV.
// All values come from Tauri commands (see src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";

export interface DeviceFingerprint {
  hwid: string;        // Stable per-machine ID (machine-uid crate)
  platform: string;    // "Windows" / "macOS" / "Linux"
  osVersion: string;   // e.g. "11" / "26.4" / "24.04"
  model: string;       // OS edition / hardware model when available
  userAgent: string;   // "ToBeVPN/<appVersion>/<platformLower>/<numericBuildCode>"
}

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
const APP_BUILD_CODE = numericBuildCode(APP_VERSION);

let cached: DeviceFingerprint | null = null;
let inFlight: Promise<DeviceFingerprint> | null = null;
const INVOKE_TIMEOUT_MS = 2_000;
const MAX_FINGERPRINT_FIELD_LENGTH = 128;

function numericBuildCode(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".", 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  return String(major * 1_000_000 + minor * 1_000 + patch);
}

function sanitizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FINGERPRINT_FIELD_LENGTH);
}

async function safeInvoke(cmd: string): Promise<string> {
  let timeoutId: number | null = null;
  const invocation = invoke<string>(cmd).catch(() => "");
  try {
    const value = await Promise.race([
      invocation,
      new Promise<string>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(""), INVOKE_TIMEOUT_MS);
      }),
    ]);
    return sanitizeField(value);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

export async function getDeviceFingerprint(): Promise<DeviceFingerprint> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  const promise = (async () => {
    const [hwid, platform, osVersion, model] = await Promise.all([
      safeInvoke("get_hwid"),
      safeInvoke("get_os_name"),
      safeInvoke("get_os_version"),
      safeInvoke("get_device_model"),
    ]);
    const platformSlug =
      platform.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64) || "desktop";
    cached = {
      hwid,
      platform: platform || "Desktop",
      osVersion,
      model: model || "Desktop",
      userAgent: `ToBeVPN/${APP_VERSION}/${platformSlug}/${APP_BUILD_CODE}`,
    };
    return cached;
  })().finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}
