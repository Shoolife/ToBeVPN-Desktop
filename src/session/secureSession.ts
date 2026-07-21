import { invoke } from "@tauri-apps/api/core";
import {
  getSessionSecrets,
  type SessionSecrets,
} from "./store";

const FALLBACK_STORAGE_KEY = "tobevpn_secure_session_v1";
const STORAGE_MODE_KEY = "tobevpn_secure_storage_mode_v1";
const SECURE_SESSION_TOMBSTONE = "tobevpn-revoked-v1";
const CLEAR_TOMBSTONE_KEY = "tobevpn_secure_session_clear_pending_v1";
const KEYRING_TIMEOUT_MS = 1500;

type StorageMode = "keyring" | "fallback";

let cachedMode: StorageMode | null = null;
let lastPersistedPayload: string | null = null;
let secureInvokeQueue: Promise<void> = Promise.resolve();
let secureClearGeneration = 0;
let keyringActivityStarted = false;

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
  // Preserve the real native completion order even when the UI-facing wait
  // times out. A later clear remains queued behind an earlier slow save.
  const operation = secureInvokeQueue.then(() => invoke<T>(cmd, args));
  secureInvokeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  let timeoutId: number | null = null;
  try {
    return await Promise.race([
      operation,
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

function hasClearTombstone(): boolean {
  try {
    return localStorage.getItem(CLEAR_TOMBSTONE_KEY) === "1";
  } catch {
    return true;
  }
}

function setClearTombstone(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(CLEAR_TOMBSTONE_KEY, "1");
    else localStorage.removeItem(CLEAR_TOMBSTONE_KEY);
  } catch {
    // The in-process queue still preserves ordering for this run.
  }
}

function parseSecrets(raw: string | null): SessionSecrets | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionSecrets>;
    if (
      typeof parsed.deviceId !== "string" ||
      !parsed.deviceId.trim() ||
      parsed.deviceId.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(parsed.deviceId) ||
      typeof parsed.accessToken !== "string" ||
      !parsed.accessToken.trim() ||
      parsed.accessToken.length > 16 * 1024 ||
      /[\u0000-\u001f\u007f]/.test(parsed.accessToken) ||
      typeof parsed.refreshToken !== "string" ||
      !parsed.refreshToken.trim() ||
      parsed.refreshToken.length > 16 * 1024 ||
      /[\u0000-\u001f\u007f]/.test(parsed.refreshToken) ||
      typeof parsed.accessTokenExpiresAt !== "number" ||
      !Number.isSafeInteger(parsed.accessTokenExpiresAt) ||
      typeof parsed.refreshTokenExpiresAt !== "number" ||
      !Number.isSafeInteger(parsed.refreshTokenExpiresAt) ||
      parsed.accessTokenExpiresAt <= 0 ||
      parsed.refreshTokenExpiresAt <= 0 ||
      parsed.accessTokenExpiresAt > 4_102_444_800_000 ||
      parsed.refreshTokenExpiresAt > 4_102_444_800_000
    ) {
      return null;
    }
    return {
      deviceId: parsed.deviceId.trim(),
      accessToken: parsed.accessToken.trim(),
      refreshToken: parsed.refreshToken.trim(),
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
  const mode = loadStorageMode();
  const clearGeneration = secureClearGeneration;
  if (mode === "fallback") {
    return loadFallbackSecrets();
  }

  if (hasClearTombstone()) {
    saveFallbackSecrets(null);
    keyringActivityStarted = true;
    try {
      await invokeSecure("clear_secure_session");
      if (clearGeneration === secureClearGeneration) {
        setClearTombstone(false);
      }
    } catch (error) {
      console.warn("[secureSession] pending keyring clear failed:", error);
    }
    return null;
  }

  try {
    keyringActivityStarted = true;
    const raw = await invokeSecure<string | null>("load_secure_session");
    if (
      clearGeneration !== secureClearGeneration ||
      hasClearTombstone()
    ) return null;
    if (raw === SECURE_SESSION_TOMBSTONE) {
      // Native storage overwrites with this marker before deletion. Treat a
      // retained marker as an authoritative logout, never as permission to
      // resurrect an older plaintext fallback.
      saveFallbackSecrets(null);
      return null;
    }
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
    if (clearGeneration !== secureClearGeneration) return null;
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
  const mode = loadStorageMode();
  if (mode === "fallback") {
    if (payload !== lastPersistedPayload) saveFallbackSecrets(secrets);
    return;
  }
  if (payload === lastPersistedPayload && !hasClearTombstone()) return;

  const clearGeneration = secureClearGeneration;
  try {
    keyringActivityStarted = true;
    await invokeSecure("save_secure_session", { value: payload });
    if (clearGeneration !== secureClearGeneration) return;
    lastPersistedPayload = payload;
    setClearTombstone(false);
    saveFallbackSecrets(null);
  } catch (error) {
    if (clearGeneration !== secureClearGeneration) return;
    console.warn("[secureSession] keyring save failed, switching to fallback:", error);
    setStorageMode("fallback");
    saveFallbackSecrets(secrets);
  }
}

export async function clearSecureSession(): Promise<void> {
  const clearGeneration = ++secureClearGeneration;
  setClearTombstone(true);
  lastPersistedPayload = null;
  saveFallbackSecrets(null);
  const mode = loadStorageMode();
  if (mode === "fallback" && !keyringActivityStarted) return;

  try {
    await invokeSecure("clear_secure_session");
    if (clearGeneration === secureClearGeneration) {
      setClearTombstone(false);
    }
  } catch (error) {
    console.warn("[secureSession] keyring clear failed; revocation marker retained:", error);
    if (mode === "keyring") setStorageMode("fallback");
  }
}

export async function persistCurrentSessionSecrets(): Promise<void> {
  await saveSecureSession(getSessionSecrets());
}
