// Home router detection for the Router section (Devices screen).
//
// The native side finds the default gateway and reads the router's login
// page, which needs no password. Store builds have no Router section: they
// cannot run SSH or install software on another device.
import { invoke } from "@tauri-apps/api/core";
import type { LinkedDeviceDto } from "../api/types";
import { isBrowserPreviewRuntime } from "./browserPreview";

export interface RouterInfo {
  /** Default gateway, e.g. "192.168.1.1"; null without a network. */
  gateway: string | null;
  /** Model from the login page, e.g. "SNR-CPE-AX2". */
  model: string | null;
  /** "easywrt" (SNR's OpenWrt), "openwrt", or null when not recognised. */
  firmware: string | null;
  /** The installer has been verified on this model. */
  supported: boolean;
}

export const ROUTER_SECTION_AVAILABLE = !import.meta.env.VITE_STORE_BUILD;

const EMPTY: RouterInfo = { gateway: null, model: null, firmware: null, supported: false };

let cached: RouterInfo | null = null;
let inFlight: Promise<RouterInfo> | null = null;

/** Detected router; cached for the session unless `refresh` is set. */
export async function detectRouter(refresh = false): Promise<RouterInfo> {
  if (!ROUTER_SECTION_AVAILABLE || isBrowserPreviewRuntime()) return EMPTY;
  if (cached && !refresh) return cached;
  if (inFlight) return inFlight;
  inFlight = invoke<RouterInfo>("detect_router")
    .then((info) => {
      cached = info;
      return info;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function getCachedRouter(): RouterInfo | null {
  return cached;
}

/** Human-readable firmware family. */
export function routerFirmwareLabel(firmware: string | null): string | null {
  if (firmware === "easywrt") return "EasyWRT";
  if (firmware === "openwrt") return "OpenWrt";
  return null;
}

/**
 * A router linked to the account fetches its subscription with a "/router/"
 * User-Agent and OpenWrt as its OS. Such a device is shown once, as the
 * router card, not again in the list of other devices.
 */
export function isRouterDevice(device: LinkedDeviceDto): boolean {
  const userAgent = (device.user_agent ?? "").toLowerCase();
  const platform = (device.platform ?? "").toLowerCase();
  const type = (device.device_type ?? "").toLowerCase();
  return type === "router" || userAgent.includes("/router/") || platform === "openwrt";
}
