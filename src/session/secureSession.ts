import { invoke } from "@tauri-apps/api/core";
import {
  getSessionSecrets,
  type SessionSecrets,
} from "./store";

const FALLBACK_STORAGE_KEY = "tobevpn_secure_session_v1";
const STORAGE_MODE_KEY = "tobevpn_secure_storage_mode_v1";
const KEYRING_TIMEOUT_MS = 1500;

type StorageMode = "keyring" | "fallback";

let cachedMode: StorageMode | null = null;
let lastPersistedPayload: string | null = null;

// Try the platform keyring first on every OS — including Linux. On systems
// without secret-service (headless / minimal WMs), the first invocation
// times out and we sticky-switch to the localStorage fallback for this
// session. We do NOT pre-flag Linux as fallback — most users have
// gnome-keyring or kwallet running, and forcing fallback there means
// auth tokens land in plain JSON on disk.
function loadStorageMode(): StorageMode {
  if (cachedMode) return cachedMode;
  try {
    const raw = localStorage.getItem(STORAGE_MODE_KEY);
    if (raw === "fallback") {
      cachedMode = "fallback";
      return cachedMode;
    }
  } catch {
    // ignore
  }
  cachedMode = "keyring";
  return cachedMode;
}

function setStorageMode(mode: StorageMode) {
  cachedMode = mode;
  try {
    localStorage.setItem(STORAGE_MODE_KEY, mode);
  } catch {
    // ignore
  }
}

async function invokeSecure<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  let timeoutId: number | null = null;
  try {
    return await Promise.race([
      invoke<T>(cmd, args),
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`Secure storage timeout (${KEYRING_TIMEOUT_MS}ms)`));
        }, KEYRING_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function parseSecrets(raw: string | null): SessionSecrets | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionSecrets>;
    if (
      typeof parsed.deviceId !== "string" ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.accessTokenExpiresAt !== "number" ||
      typeof parsed.refreshTokenExpiresAt !== "number"
    ) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresAt: parsed.accessTokenExpiresAt,
      refreshTokenExpiresAt: parsed.refreshTokenExpiresAt,
    };
  } catch {
    return null;
  }
}

function loadFallbackSecrets(): SessionSecrets | null {
  try {
    const parsed = parseSecrets(localStorage.getItem(FALLBACK_STORAGE_KEY));
    lastPersistedPayload = parsed ? JSON.stringify(parsed) : null;
    return parsed;
  } catch {
    return null;
  }
}

function saveFallbackSecrets(secrets: SessionSecrets | null) {
  try {
    if (secrets) {
      localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(secrets));
      lastPersistedPayload = JSON.stringify(secrets);
    } else {
      localStorage.removeItem(FALLBACK_STORAGE_KEY);
      lastPersistedPayload = null;
    }
  } catch {
    // ignore
  }
}

export async function loadSecureSession(): Promise<SessionSecrets | null> {
  if (loadStorageMode() === "fallback") {
    return loadFallbackSecrets();
  }

  try {
    const raw = await invokeSecure<string | null>("load_secure_session");
    if (typeof raw === "string") {
      const parsed = parseSecrets(raw);
      if (parsed) {
        lastPersistedPayload = JSON.stringify(parsed);
        saveFallbackSecrets(null);
        return parsed;
      }
    }
    return loadFallbackSecrets();
  } catch (error) {
    console.warn("[secureSession] keyring load failed, switching to fallback:", error);
    setStorageMode("fallback");
    return loadFallbackSecrets();
  }
}

export async function saveSecureSession(secrets: SessionSecrets | null): Promise<void> {
  if (!secrets) {
    await clearSecureSession();
    return;
  }

  const payload = JSON.stringify(secrets);
  if (payload === lastPersistedPayload) return;

  if (loadStorageMode() === "fallback") {
    saveFallbackSecrets(secrets);
    return;
  }

  try {
    await invokeSecure("save_secure_session", { value: payload });
    lastPersistedPayload = payload;
    saveFallbackSecrets(null);
  } catch (error) {
    console.warn("[secureSession] keyring save failed, switching to fallback:", error);
    setStorageMode("fallback");
    saveFallbackSecrets(secrets);
  }
}

export async function clearSecureSession(): Promise<void> {
  lastPersistedPayload = null;
  if (loadStorageMode() === "fallback") {
    saveFallbackSecrets(null);
    return;
  }

  try {
    await invokeSecure("clear_secure_session");
  } catch (error) {
    console.warn("[secureSession] keyring clear failed, switching to fallback:", error);
    setStorageMode("fallback");
  }
  saveFallbackSecrets(null);
}

export async function persistCurrentSessionSecrets(): Promise<void> {
  await saveSecureSession(getSessionSecrets());
}
