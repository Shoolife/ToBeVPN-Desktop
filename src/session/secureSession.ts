import { invoke } from "@tauri-apps/api/core";
import { getSessionSecrets, type SessionSecrets } from "./store";

// v1 stored tokens as plaintext after a short keyring timeout. It is read only
// for one-time migration and removed before any asynchronous operation starts.
const LEGACY_FALLBACK_STORAGE_KEY = "tobevpn_secure_session_v1";
const LEGACY_STORAGE_MODE_KEY = "tobevpn_secure_storage_mode_v1";
const CLEAR_TOMBSTONE_KEY = "tobevpn_secure_session_clear_pending_v1";

let lastPersistedPayload: string | null = null;
let secureOperationQueue: Promise<void> = Promise.resolve();
// Incremented synchronously whenever credentials are revoked. A save/load that
// was already in flight must never clear the durable revocation marker after a
// newer logout request.
let secureClearGeneration = 0;

function enqueueSecureOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = secureOperationQueue.then(operation, operation);
  secureOperationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
      typeof parsed.refreshToken !== "string" ||
      !parsed.refreshToken.trim() ||
      parsed.accessToken.length > 16 * 1024 ||
      parsed.refreshToken.length > 16 * 1024 ||
      /[\u0000-\u001f\u007f]/.test(parsed.accessToken) ||
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

function takeLegacyPlaintextSecrets(): SessionSecrets | null {
  try {
    const parsed = parseSecrets(localStorage.getItem(LEGACY_FALLBACK_STORAGE_KEY));
    // Delete first: a crash or keyring failure must not leave reusable tokens
    // in WebView storage.
    localStorage.removeItem(LEGACY_FALLBACK_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_MODE_KEY);
    return parsed;
  } catch {
    return null;
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
    // If storage is unavailable, the in-process operation queue still
    // preserves save/clear ordering for the current run.
  }
}

export async function loadSecureSession(): Promise<SessionSecrets | null> {
  const legacySecrets = takeLegacyPlaintextSecrets();
  const clearGeneration = secureClearGeneration;
  return enqueueSecureOperation(async () => {
    if (hasClearTombstone()) {
      try {
        await invoke("clear_secure_session");
        if (clearGeneration === secureClearGeneration) {
          setClearTombstone(false);
        }
      } catch (error) {
        console.warn("[secureSession] pending keyring clear failed:", error);
      }
      lastPersistedPayload = null;
      return null;
    }

    if (legacySecrets) {
      const payload = JSON.stringify(legacySecrets);
      try {
        await invoke("save_secure_session", { value: payload });
        if (
          clearGeneration !== secureClearGeneration ||
          hasClearTombstone()
        ) {
          lastPersistedPayload = null;
          return null;
        }
        lastPersistedPayload = payload;
      } catch (error) {
        // Keep the migrated value in memory for this run, but never write it
        // back to plaintext storage.
        console.warn("[secureSession] legacy token migration failed:", error);
        if (
          clearGeneration !== secureClearGeneration ||
          hasClearTombstone()
        ) {
          lastPersistedPayload = null;
          return null;
        }
      }
      return legacySecrets;
    }

    try {
      const raw = await invoke<string | null>("load_secure_session");
      if (
        clearGeneration !== secureClearGeneration ||
        hasClearTombstone()
      ) {
        lastPersistedPayload = null;
        return null;
      }
      const parsed = typeof raw === "string" ? parseSecrets(raw) : null;
      lastPersistedPayload = parsed ? JSON.stringify(parsed) : null;
      return parsed;
    } catch (error) {
      console.warn("[secureSession] keyring load failed; using memory-only session:", error);
      lastPersistedPayload = null;
      return null;
    }
  });
}

export async function saveSecureSession(secrets: SessionSecrets | null): Promise<void> {
  if (!secrets) {
    await clearSecureSession();
    return;
  }
  const payload = JSON.stringify(secrets);
  if (payload === lastPersistedPayload && !hasClearTombstone()) return;
  const clearGeneration = secureClearGeneration;

  await enqueueSecureOperation(async () => {
    // A clear requested after this save was queued supersedes it. Skipping the
    // write also avoids briefly resurrecting the old token in the keyring.
    if (clearGeneration !== secureClearGeneration) return;
    try {
      await invoke("save_secure_session", { value: payload });
      if (
        clearGeneration !== secureClearGeneration ||
        hasClearTombstone()
      ) {
        // The write may have won a race with a newer clear. Keep the tombstone
        // set so a crash before the queued delete cannot revive this payload.
        lastPersistedPayload = null;
        return;
      }
      lastPersistedPayload = payload;
      setClearTombstone(false);
    } catch (error) {
      lastPersistedPayload = null;
      console.warn("[secureSession] keyring save failed; session is memory-only:", error);
    }
  });
}

export async function clearSecureSession(): Promise<void> {
  // Mark revoked synchronously, before waiting behind an in-flight save. A
  // future launch refuses to load the keyring value until deletion succeeds.
  const clearGeneration = ++secureClearGeneration;
  setClearTombstone(true);
  lastPersistedPayload = null;
  takeLegacyPlaintextSecrets();
  await enqueueSecureOperation(async () => {
    try {
      await invoke("clear_secure_session");
      if (clearGeneration === secureClearGeneration) {
        setClearTombstone(false);
      }
    } catch (error) {
      console.warn("[secureSession] keyring clear failed; tombstone retained:", error);
    }
  });
}

export async function persistCurrentSessionSecrets(): Promise<void> {
  await saveSecureSession(getSessionSecrets());
}
