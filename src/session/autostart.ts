import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const AUTOSTART_CONNECT_EVENT = "autostart-connect-requested";

export async function launchedFromAutostart(): Promise<boolean> {
  return invoke<boolean>("launched_from_autostart");
}

export async function listenForAutostartConnect(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(AUTOSTART_CONNECT_EVENT, handler);
}

export async function getAutostartEnabled(): Promise<boolean> {
  return invoke<boolean>("get_autostart_enabled");
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  await invoke("set_autostart_enabled", { enabled });
}
