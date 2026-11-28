import { openUrl } from "@tauri-apps/plugin-opener";
import { telegramDeepLink } from "./telegramLinks";

/**
 * Opens a link outside the app. A Telegram web link (t.me) opens straight
 * in the Telegram app through its tg:// deep link; when that fails (no
 * Telegram installed to take it), the web link opens in the browser, as
 * every link did before. Other links open in the browser.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const deepLink = telegramDeepLink(url);
  if (deepLink) {
    try {
      await openUrl(deepLink);
      return;
    } catch {
      // No handler for tg://: the browser page offers Telegram Web instead.
    }
  }
  await openUrl(url);
}
