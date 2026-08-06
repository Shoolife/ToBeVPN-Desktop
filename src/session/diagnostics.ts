import { invoke } from "@tauri-apps/api/core";
import { isBrowserPreviewRuntime } from "./browserPreview";

export interface DiagnosticState {
  debugModeEnabled: boolean;
  collecting: boolean;
  hasCurrentLog: boolean;
  currentLogSizeBytes: number;
  currentLogDate: string | null;
}

export interface DiagnosticLogFileInfo {
  fileName: string;
  date: string;
  sizeBytes: number;
}

export type DiagnosticLevel = "D" | "I" | "W" | "E";

const EMPTY_STATE: DiagnosticState = {
  debugModeEnabled: false,
  collecting: false,
  hasCurrentLog: false,
  currentLogSizeBytes: 0,
  currentLogDate: null,
};

let state: DiagnosticState = EMPTY_STATE;
let initializePromise: Promise<DiagnosticState> | null = null;
const listeners = new Set<() => void>();

function publish(next: DiagnosticState): DiagnosticState {
  state = {
    debugModeEnabled: Boolean(next.debugModeEnabled),
    collecting: Boolean(next.debugModeEnabled && next.collecting),
    hasCurrentLog: Boolean(next.hasCurrentLog),
    currentLogSizeBytes: Math.max(0, Number(next.currentLogSizeBytes) || 0),
    currentLogDate: typeof next.currentLogDate === "string" ? next.currentLogDate : null,
  };
  listeners.forEach((listener) => listener());
  return state;
}

function previewToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDiagnosticStateSnapshot(): DiagnosticState {
  return state;
}

export function subscribeDiagnosticState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initializeDiagnostics(): Promise<DiagnosticState> {
  if (initializePromise) return initializePromise;
  initializePromise = isBrowserPreviewRuntime()
    ? Promise.resolve(state)
    : invoke<DiagnosticState>("get_diagnostic_state")
        .then(publish)
        .catch((error) => {
          initializePromise = null;
          throw error;
        });
  return initializePromise;
}

export async function refreshDiagnosticState(): Promise<DiagnosticState> {
  if (isBrowserPreviewRuntime()) return state;
  return publish(await invoke<DiagnosticState>("get_diagnostic_state"));
}

export async function setDiagnosticMode(enabled: boolean): Promise<DiagnosticState> {
  if (isBrowserPreviewRuntime()) {
    return publish({
      ...state,
      debugModeEnabled: enabled,
      collecting: enabled && state.collecting,
    });
  }
  return publish(
    await invoke<DiagnosticState>("set_diagnostic_mode", { enabled }),
  );
}

export async function setDiagnosticCollection(enabled: boolean): Promise<DiagnosticState> {
  if (isBrowserPreviewRuntime()) {
    if (enabled && !state.debugModeEnabled) throw new Error("Diagnostic mode is disabled");
    return publish({
      ...state,
      collecting: enabled,
      hasCurrentLog: enabled || state.hasCurrentLog,
      currentLogDate: enabled ? previewToday() : state.currentLogDate,
      currentLogSizeBytes: enabled ? Math.max(18432, state.currentLogSizeBytes) : state.currentLogSizeBytes,
    });
  }
  return publish(
    await invoke<DiagnosticState>("set_diagnostic_collection", { enabled }),
  );
}

export function recordDiagnosticEvent(
  tag: string,
  message: string,
  level: DiagnosticLevel = "I",
): void {
  if (isBrowserPreviewRuntime()) return;
  const submit = () => invoke("append_diagnostic_event", { level, tag, message }).catch(() => {
    // Diagnostics must never interfere with VPN or UI operation.
  });
  if (state.collecting) {
    void submit();
    return;
  }
  // The first startup events can happen before React has mounted the App
  // effect that primes this cache. Resolve native state once and preserve the
  // event only when collection had already been enabled by the user.
  void initializeDiagnostics()
    .then((current) => {
      if (current.collecting) return submit();
    })
    .catch(() => {});
}

export async function listDiagnosticLogs(): Promise<DiagnosticLogFileInfo[]> {
  if (isBrowserPreviewRuntime()) {
    if (!state.hasCurrentLog) return [];
    return [
      {
        fileName: `ToBeVPN-diagnostic-${previewToday()}.log`,
        date: previewToday(),
        sizeBytes: state.currentLogSizeBytes,
      },
      {
        fileName: "ToBeVPN-diagnostic-2026-08-04.log",
        date: "2026-08-04",
        sizeBytes: 428_416,
      },
    ];
  }
  const logs = await invoke<DiagnosticLogFileInfo[]>("list_diagnostic_logs");
  return logs
    .filter((log) => /^ToBeVPN-diagnostic-\d{4}-\d{2}-\d{2}\.log$/.test(log.fileName))
    .map((log) => ({
      ...log,
      sizeBytes: Math.max(0, Number(log.sizeBytes) || 0),
    }));
}

export async function exportDiagnosticLog(fileName?: string): Promise<string> {
  if (isBrowserPreviewRuntime()) {
    return `/home/ivan/Загрузки/${fileName ?? `ToBeVPN-diagnostic-${previewToday()}.log`}`;
  }
  return invoke<string>("export_diagnostic_log", {
    fileName: fileName ?? null,
  });
}

export async function deleteDiagnosticLog(fileName: string): Promise<DiagnosticState> {
  if (isBrowserPreviewRuntime()) {
    const isCurrent = fileName.includes(previewToday());
    return publish(
      isCurrent
        ? {
            ...state,
            hasCurrentLog: false,
            currentLogDate: null,
            currentLogSizeBytes: 0,
          }
        : state,
    );
  }
  return publish(
    await invoke<DiagnosticState>("delete_diagnostic_log", { fileName }),
  );
}
