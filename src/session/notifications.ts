import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSavedLang, t, tf } from "../i18n";
import { isBrowserPreviewRuntime } from "./browserPreview";
import { recordDiagnosticEvent } from "./diagnostics";
import { getSession, isDemoSession, subscribeSession, type Session } from "./store";
import { trafficResetText } from "./trafficReset";

// System notifications ported from the Android client: the traffic balance
// alerts (TrafficLimitNotifications / TrafficLimitAlerts.kt) and the
// successful payment notice (PaymentNotifications.kt).

function showSystemNotification(kind: string, title: string, body: string): void {
  if (isBrowserPreviewRuntime()) return;
  void invoke("show_system_notification", { kind, title, body }).catch((error) => {
    recordDiagnosticEvent("Notifications", `Notification failed: kind=${kind}, ${String(error)}`, "W");
  });
}

// --- Payment ---

// The in-app "Subscription activated" banner on the home screen, shown until
// the user closes it (MainViewModel.paymentSuccessVisible on the phone).
let paymentSuccessVisible = false;
const paymentSuccessListeners = new Set<() => void>();

function setPaymentSuccessVisible(visible: boolean): void {
  if (paymentSuccessVisible === visible) return;
  paymentSuccessVisible = visible;
  paymentSuccessListeners.forEach((listener) => listener());
}

export function notifyPaymentSucceeded(): void {
  setPaymentSuccessVisible(true);
  showSystemNotification("payment", t("payment_success_title"), t("payment_success_description"));
}

export function dismissPaymentSuccess(): void {
  setPaymentSuccessVisible(false);
}

export function usePaymentSuccessVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      paymentSuccessListeners.add(listener);
      return () => paymentSuccessListeners.delete(listener);
    },
    () => paymentSuccessVisible,
  );
}

// --- Traffic balance ---

/** Remaining-traffic thresholds, most urgent last, as on the phone. */
const THRESHOLDS = [
  { percent: 20, mask: 1 },
  { percent: 10, mask: 1 << 1 },
  { percent: 5, mask: 1 << 2 },
] as const;

const ONE_GIB = 1024 * 1024 * 1024;
const ALERT_STATE_KEY = "tobevpn_traffic_limit_alert_v1";

interface TrafficLimitAlertState {
  limitBytes: number;
  lastUsedBytes: number;
  notifiedThresholdMask: number;
}

const EMPTY_STATE: TrafficLimitAlertState = { limitBytes: 0, lastUsedBytes: 0, notifiedThresholdMask: 0 };

/**
 * Selects at most one alert for an observation. If usage jumps over several
 * boundaries between server synchronisations, only the most urgent crossed
 * boundary is shown and all less urgent ones are marked as handled. A new
 * limit or a drop in usage (a new billing period) starts the cycle again.
 */
export function evaluateTrafficLimitAlert(
  usedBytes: number,
  limitBytes: number,
  previous: TrafficLimitAlertState,
): { state: TrafficLimitAlertState; thresholdToNotify: number | null } {
  if (!(limitBytes > 0)) return { state: EMPTY_STATE, thresholdToNotify: null };

  const used = Math.min(Math.max(0, usedBytes), limitBytes);
  const resetTolerance = Math.max(ONE_GIB, Math.floor(limitBytes / 20));
  const cycleRestarted = previous.limitBytes !== limitBytes ||
    previous.lastUsedBytes - used >= resetTolerance;
  const startingMask = cycleRestarted ? 0 : previous.notifiedThresholdMask;
  const remainingRatio = (limitBytes - used) / limitBytes;
  const reached = THRESHOLDS.filter((threshold) => remainingRatio <= threshold.percent / 100);
  const reachedMask = reached.reduce((mask, threshold) => mask | threshold.mask, 0);
  const newlyReached = reached.filter((threshold) => (startingMask & threshold.mask) === 0);
  const thresholdToNotify = newlyReached.length > 0
    ? Math.min(...newlyReached.map((threshold) => threshold.percent))
    : null;

  return {
    state: { limitBytes, lastUsedBytes: used, notifiedThresholdMask: startingMask | reachedMask },
    thresholdToNotify,
  };
}

function readAlertState(): TrafficLimitAlertState {
  try {
    const parsed = JSON.parse(localStorage.getItem(ALERT_STATE_KEY) ?? "null") as Partial<TrafficLimitAlertState> | null;
    if (!parsed) return EMPTY_STATE;
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    return {
      limitBytes: num(parsed.limitBytes),
      lastUsedBytes: num(parsed.lastUsedBytes),
      notifiedThresholdMask: num(parsed.notifiedThresholdMask),
    };
  } catch {
    return EMPTY_STATE;
  }
}

function writeAlertState(state: TrafficLimitAlertState): void {
  try {
    localStorage.setItem(ALERT_STATE_KEY, JSON.stringify(state));
  } catch {
    // Without storage the next launch may repeat one alert; nothing worse.
  }
}

/** Remaining GB with the phone's precision: 2 digits below 1, 1 below 10. */
function formatGib(bytes: number): string {
  const value = Math.max(0, bytes) / ONE_GIB;
  return new Intl.NumberFormat(getSavedLang() === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: value < 1 ? 2 : value < 10 ? 1 : 0,
  }).format(value);
}

function processUsage(session: Session): void {
  // The demo account shows sample numbers; it must not raise real alerts.
  const linked = session.isLinked && !isDemoSession(session);
  const limitBytes = linked ? session.trafficLimitBytes : 0;
  const usedBytes = linked ? session.trafficUsedBytes : 0;

  const previous = readAlertState();
  const { state, thresholdToNotify } = evaluateTrafficLimitAlert(usedBytes, limitBytes, previous);
  if (
    state.limitBytes !== previous.limitBytes ||
    state.lastUsedBytes !== previous.lastUsedBytes ||
    state.notifiedThresholdMask !== previous.notifiedThresholdMask
  ) {
    writeAlertState(state);
  }
  if (thresholdToNotify === null) return;

  const remaining = Math.min(Math.max(0, limitBytes - usedBytes), limitBytes);
  // With a known reset date the user can tell whether to wait or renew.
  const reset = trafficResetText(session.trafficResetAt, limitBytes);
  const description = tf("traffic_limit_notification_description", formatGib(remaining));
  showSystemNotification(
    "traffic_limit",
    t("traffic_limit_notification_title"),
    reset ? `${description} ${reset.full}.` : description,
  );
  recordDiagnosticEvent(
    "Notifications",
    `Traffic limit notification shown: remaining_threshold_percent=${thresholdToNotify}`,
  );
}

let trafficAlertsStarted = false;

/** Watches the synced traffic usage for the whole app lifetime. */
export function startTrafficLimitNotifications(): void {
  if (trafficAlertsStarted || isBrowserPreviewRuntime()) return;
  trafficAlertsStarted = true;
  let lastUsed = -1;
  let lastLimit = -1;
  const onSession = (session: Session) => {
    if (session.trafficUsedBytes === lastUsed && session.trafficLimitBytes === lastLimit) return;
    lastUsed = session.trafficUsedBytes;
    lastLimit = session.trafficLimitBytes;
    processUsage(session);
  };
  subscribeSession(onSession);
  onSession(getSession());
}
