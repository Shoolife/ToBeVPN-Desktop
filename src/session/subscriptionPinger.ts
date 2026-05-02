// Direct GET on the panel's public subscription URL with HWID headers.
// This is the only request panel actually parses to create/refresh an
// HWID device record; the bot's /api/* endpoints don't expose it to the panel.
// We hit the URL (a) before each VPN connect, (b) on subscription refresh.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getDeviceFingerprint } from "./fingerprint";

// Panel sets `access-control-allow-origin: *`, so window.fetch would also work
// from a webview. We use tauriFetch in production for consistency with the rest
// of the API client (avoids any platform CORS quirks).
const httpFetch: typeof fetch = import.meta.env.DEV ? window.fetch.bind(window) : tauriFetch;

export async function pingSubscriptionUrl(subscriptionUrl: string | null | undefined): Promise<void> {
  if (!subscriptionUrl) return;
  try {
    const fp = await getDeviceFingerprint();
    const headers: HeadersInit = {
      "x-device-os": fp.platform,
      "x-ver-os": fp.osVersion,
      "x-device-model": fp.model,
      "User-Agent": fp.userAgent,
    };
    if (fp.hwid) (headers as Record<string, string>)["x-hwid"] = fp.hwid;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    try {
      await httpFetch(subscriptionUrl, { method: "GET", headers, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e) {
    console.warn("[pingSubscriptionUrl] failed:", e);
  }
}
