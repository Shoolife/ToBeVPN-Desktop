import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { t, tf, getSavedLang, type StringKey } from "../i18n";
import {
  fetchPurchasePlans,
  markPendingPurchaseStarted,
  pingHwidOnly,
  startPendingPurchaseRefreshIfNeeded,
} from "../session/auth";
import { useSession, type UserPlan } from "../session/store";
import { getCurrentPlan } from "../api/client";
import type { CurrentPlanDto, PurchaseDurationDto, PurchasePlanDto, PurchasePlansDto } from "../api/types";
import { formatDateDots } from "../session/dateFormat";
import Spinner from "./Spinner";
import "./SubscriptionSheet.css";

interface CurrentLimits {
  trafficLimitBytes: number;
  deviceLimit: number;
}

function normalizePlanTrafficLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value <= 0) return 0;
  return value > 1024 * 1024 ? value : value * 1024 * 1024 * 1024;
}

function currentLimitsFromPlan(dto: CurrentPlanDto | null | undefined): CurrentLimits | null {
  if (!dto) return null;
  const snapshot = dto.current_plan ?? dto.plan_snapshot ?? null;
  const subscription = dto.subscription ?? null;
  const trafficLimitBytes =
    subscription?.traffic_limit_bytes ??
    normalizePlanTrafficLimit(subscription?.traffic_limit) ??
    snapshot?.traffic_limit_bytes ??
    normalizePlanTrafficLimit(snapshot?.traffic_limit);
  const deviceLimit = subscription?.device_limit ?? snapshot?.device_limit;
  if (trafficLimitBytes === null && deviceLimit === null) return null;
  return {
    trafficLimitBytes: trafficLimitBytes ?? 0,
    deviceLimit: deviceLimit ?? 0,
  };
}

const BOT_NAME = "meow_meow_vpn_bot";
const FALLBACK_PLAN_DURATIONS = [
  { days: 1, rubPrice: 15 },
  { days: 7, rubPrice: 65 },
  { days: 30, rubPrice: 200 },
  { days: 90, rubPrice: 500 },
  { days: 365, rubPrice: 1500 },
];

interface PlanRow {
  key: string;
  title: string;
  description: string;
  priceDisplay: string;
  paymentUrl: string | null;
}

function planTitleKey(days: number): StringKey | null {
  switch (days) {
    case 1: return "plan_day";
    case 7: return "plan_week";
    case 30: return "plan_month";
    case 90: return "plan_3month";
    case 365: return "plan_year";
    default: return null;
  }
}

function planTitle(days: number): string {
  const key = planTitleKey(days);
  return key ? t(key) : `${days}`;
}

function planKey(days: number): string {
  switch (days) {
    case 1: return "day";
    case 7: return "week";
    case 30: return "month";
    case 90: return "3month";
    case 365: return "year";
    default: return `d${days}`;
  }
}

function formatRub(amount: string): string {
  const v = Number(amount);
  if (!Number.isFinite(v)) return `${amount}\u20BD`;
  const intPart = Math.trunc(v);
  const formatted =
    intPart >= 1000
      ? intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
      : intPart.toString();
  return `${formatted}\u20BD`;
}

function formatUsd(amount: string): string {
  const v = Number(amount);
  if (!Number.isFinite(v)) return `$${amount}`;
  return `$${v.toFixed(2)}`;
}

function formatStars(amount: string): string {
  const v = Number(amount);
  if (!Number.isFinite(v)) return `${amount} \u2B50`;
  return `${Math.trunc(v)} \u2B50`;
}

function formatFallbackPrice(rubPrice: number, isRu: boolean): string {
  if (isRu) return formatRub(String(rubPrice));
  return formatStars(String(Math.round(rubPrice / 1.3)));
}

function formatDurationPrice(duration: PurchaseDurationDto, isRu: boolean): string {
  const map = new Map(duration.prices.map((p) => [p.currency, p.amount] as const));
  if (isRu) {
    const rub = map.get("RUB");
    if (rub) return formatRub(rub);
    const usd = map.get("USD");
    if (usd) return formatUsd(usd);
    const xtr = map.get("XTR");
    if (xtr) return formatStars(xtr);
    return t("plan_unknown_name");
  }
  const usd = map.get("USD");
  if (usd) return formatUsd(usd);
  const rub = map.get("RUB");
  if (rub) return formatRub(rub);
  const xtr = map.get("XTR");
  if (xtr) return formatStars(xtr);
  return t("plan_unknown_name");
}

function planDescription(plan: PurchasePlanDto | null): string {
  const trafficGb = plan?.traffic_limit;
  const deviceLimit = plan?.device_limit;
  const trafficPart =
    trafficGb === undefined || trafficGb === null
      ? t("plan_quota_month")
      : trafficGb <= 0
        ? t("plan_unlimited_traffic")
        : tf("plan_traffic_month_fmt", trafficGb);
  const devicePart =
    deviceLimit && deviceLimit > 0
      ? tf("plan_devices_fmt", deviceLimit)
      : t("plan_devices_unknown");
  return `${trafficPart} \u00B7 ${devicePart}`;
}

function pickSourcePlan(data: PurchasePlansDto): PurchasePlanDto | null {
  const candidates = data.plans.filter((p) =>
    p.durations.some((d) => d.days > 0),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, p) =>
    p.durations.length > best.durations.length ? p : best,
  );
}

function buildRows(data: PurchasePlansDto | null, isRu: boolean): PlanRow[] {
  const sourcePlan = data ? pickSourcePlan(data) : null;
  const desc = planDescription(sourcePlan);
  if (!sourcePlan) {
    return FALLBACK_PLAN_DURATIONS.map((d) => ({
      key: planKey(d.days),
      title: planTitle(d.days),
      description: desc,
      priceDisplay: formatFallbackPrice(d.rubPrice, isRu),
      paymentUrl: null,
    }));
  }
  return [...sourcePlan.durations]
    .filter((d) => d.days > 0)
    .sort((a, b) => a.order_index - b.order_index)
    .map((d) => ({
      key: planKey(d.days),
      title: planTitle(d.days),
      description: desc,
      priceDisplay: formatDurationPrice(d, isRu),
      paymentUrl:
        d.bot_payment_url ??
        (d.bot_start_param ? `https://t.me/${BOT_NAME}?start=${d.bot_start_param}` : null),
    }));
}

function planLabel(plan: UserPlan, displayName?: string | null): string {
  if (displayName && plan !== "EXPIRED") return displayName;
  switch (plan) {
    case "PAID": return t("plan_unknown_name");
    case "ADMIN": return t("plan_unknown_name");
    case "EXPIRED": return t("plan_expired");
    case "FREE_TRIAL":
    default: return t("plan_free");
  }
}

function planNameClass(plan: UserPlan): string {
  switch (plan) {
    case "PAID":
    case "ADMIN":
      return "sub-current__name sub-current__name--green";
    case "EXPIRED":
      return "sub-current__name sub-current__name--red";
    case "FREE_TRIAL":
    default:
      return "sub-current__name sub-current__name--orange";
  }
}

export default function SubscriptionSheet({ onDismiss }: { onDismiss: () => void }) {
  const session = useSession();
  const isRu = getSavedLang() === "ru";
  const lang = getSavedLang();
  const showLimits = session.userPlan === "PAID" || session.userPlan === "ADMIN";
  const currentLimitsKey =
    session.isLinked && session.telegramId !== null
      ? `${session.telegramId}:${session.userPlan}:${session.planExpiresAt ?? ""}`
      : null;

  const [plansData, setPlansData] = useState<PurchasePlansDto | null>(null);
  const [plansLoading, setPlansLoading] = useState(true);
  const [currentLimits, setCurrentLimits] = useState<CurrentLimits | null>(null);
  const [loadedLimitsKey, setLoadedLimitsKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [qrVisible, setQrVisible] = useState(false);
  const [qrClosing, setQrClosing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const closeQr = () => {
    if (qrClosing) return;
    setQrClosing(true);
    setTimeout(() => {
      setQrVisible(false);
      setQrClosing(false);
    }, 200);
  };

  useEffect(() => {
    let cancelled = false;
    setPlansLoading(true);
    fetchPurchasePlans()
      .then((data) => {
        if (cancelled) return;
        setPlansData(data);
      })
      .catch(() => {
        if (cancelled) return;
        setPlansData(null);
      })
      .finally(() => {
        if (!cancelled) setPlansLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch real per-user limits (matches phone's loadCurrentLimits in MainViewModel).
  useEffect(() => {
    if (!session.isLinked || session.telegramId === null) {
      setCurrentLimits(null);
      setLoadedLimitsKey(null);
      return;
    }
    let cancelled = false;
    setCurrentLimits(null);
    setLoadedLimitsKey(null);
    getCurrentPlan()
      .then((response) => {
        if (cancelled) return;
        setCurrentLimits(response.success ? currentLimitsFromPlan(response.data) : null);
      })
      .catch(() => {
        if (!cancelled) setCurrentLimits(null);
      })
      .finally(() => {
        if (!cancelled) setLoadedLimitsKey(currentLimitsKey);
      });
    return () => {
      cancelled = true;
    };
  }, [currentLimitsKey, session.isLinked, session.telegramId]);

  const rows = useMemo(
    () => (plansLoading ? [] : buildRows(plansData, isRu)),
    [plansData, plansLoading, isRu],
  );

  // Keep the selection valid as the rows refresh.
  useEffect(() => {
    if (rows.length === 0) return;
    if (!selectedKey || !rows.some((r) => r.key === selectedKey)) {
      const monthRow = rows.find((r) => r.key === "month") ?? rows[0];
      setSelectedKey(monthRow.key);
    }
  }, [rows, selectedKey]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.key === selectedKey) ?? null,
    [rows, selectedKey],
  );

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onDismiss(), 240);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (qrVisible) closeQr();
        else handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qrVisible]);

  const fallbackQr = `https://t.me/${BOT_NAME}?start=buy_${selectedRow?.key ?? "month"}_${lang}`;
  const qrUrl = selectedRow?.paymentUrl ?? fallbackQr;

  const canPurchase = session.isLinked && session.telegramId !== null;
  const isRenewal = session.userPlan === "PAID" || session.userPlan === "EXPIRED";
  const handleShowQr = async () => {
    if (!canPurchase) {
      setOpenError(t("not_authorized"));
      return;
    }
    if (!selectedRow) return;
    if (await pingHwidOnly().catch(() => false)) {
      onDismiss();
      return;
    }
    markPendingPurchaseStarted({
      baselinePlan: session.userPlan,
      baselineExpiresAt: session.planExpiresAt,
    });
    startPendingPurchaseRefreshIfNeeded();
    setQrVisible(true);
  };
  const buyText = selectedRow
    ? canPurchase
      ? tf(isRenewal ? "renew_plan" : "buy_plan", selectedRow.title, selectedRow.priceDisplay)
      : t("not_authorized")
    : t("subscription");

  // Current plan summary
  const currentPlanName = planLabel(session.userPlan, session.planDisplayName);
  const currentPlanNameClass = planNameClass(session.userPlan);
  const expiresAtFormatted =
    session.planExpiresAt && (session.userPlan === "PAID" || session.userPlan === "ADMIN")
      ? formatDateDots(session.planExpiresAt)
      : null;

  // Per-status hint, mirrors phone's SubscriptionBottomSheet.
  let currentHint: string | null = null;
  switch (session.userPlan) {
    case "ADMIN":
      currentHint = expiresAtFormatted
        ? tf("plan_active_until", expiresAtFormatted)
        : null;
      break;
    case "PAID":
      currentHint = expiresAtFormatted
        ? tf("plan_active_until", expiresAtFormatted)
        : null;
      break;
    case "EXPIRED":
      currentHint = t("plan_renew_full");
      break;
    case "FREE_TRIAL":
    default:
      currentHint = t("plan_limited_traffic");
      break;
  }

  // Limits chip. For PAID/ADMIN we show unknown placeholders immediately when
  // the current user limits request is unavailable.
  const displayedLimits = loadedLimitsKey === currentLimitsKey ? currentLimits : null;
  const limitsLoading = showLimits && loadedLimitsKey !== currentLimitsKey;
  const trafficGb =
    displayedLimits && displayedLimits.trafficLimitBytes > 0
      ? Math.floor(displayedLimits.trafficLimitBytes / (1024 * 1024 * 1024))
      : null;
  const deviceLimit =
    displayedLimits && displayedLimits.deviceLimit > 0 ? displayedLimits.deviceLimit : null;
  const trafficLimitValue =
    trafficGb !== null
      ? `${trafficGb} ${t("unit_gb")}`
      : displayedLimits && displayedLimits.trafficLimitBytes <= 0
        ? "\u221E"
        : `XXX ${t("unit_gb")}`;
  const deviceLimitValue = deviceLimit !== null ? String(deviceLimit) : t("plan_unknown_name");

  return (
    <div
      className={`sub-sheet-overlay ${closing ? "sub-sheet-overlay--closing" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (qrVisible) closeQr();
          else handleClose();
        }
      }}
    >
      <div className={`sub-sheet ${closing ? "sub-sheet--closing" : ""}`}>
        <div className="sub-sheet__handle" />
        <div className="sub-sheet__content">
          <div className="sub-sheet__title">{t("subscription")}</div>

          {/* Current plan */}
          <div className="sub-current">
            <div className="sub-current__info">
              <div className="sub-current__label">{t("current_plan")}</div>
              <div className={currentPlanNameClass}>{currentPlanName}</div>
              {currentHint && <div className="sub-current__hint">{currentHint}</div>}
            </div>
            {showLimits && (
              <div className="sub-current__limits">
                {limitsLoading ? (
                  <div className="sub-current__loading">
                    <Spinner size={18} thickness={2} />
                    <span>{t("loading_data")}</span>
                  </div>
                ) : (
                  <>
                    <div className="sub-limit">
                      <div className="sub-limit__value">{trafficLimitValue}</div>
                      <div className="sub-limit__label">{t("per_month_short")}</div>
                    </div>
                    <span className="sub-current__sep">·</span>
                    <div className="sub-limit">
                      <div className="sub-limit__value">{deviceLimitValue}</div>
                      <div className="sub-limit__label">{t("devices_label")}</div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="sub-sheet__divider" />

          <div className="sub-sheet__section-title">{t("available_plans")}</div>

          {plansLoading ? (
            <div className="sub-sheet__loading">
              <Spinner size={18} thickness={2} />
              <span>{t("plans_loading")}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="sub-sheet__hint">{t("plans_load_error")}</div>
          ) : (
            rows.map((row) => (
              <div
                key={row.key}
                className={`sub-plan ${selectedKey === row.key ? "sub-plan--selected" : ""}`}
                onClick={() => setSelectedKey(row.key)}
              >
                <div className="sub-plan__radio">
                  {selectedKey === row.key && <div className="sub-plan__radio-dot" />}
                </div>
                <div className="sub-plan__info">
                  <div className="sub-plan__title">{row.title}</div>
                  <div className="sub-plan__desc">{row.description}</div>
                </div>
                <div className="sub-plan__price">{row.priceDisplay}</div>
              </div>
            ))
          )}

          <div className="sub-sheet__hint">{t("payment_via_telegram")}</div>

          <button
            className="sub-sheet__buy-btn"
            onClick={handleShowQr}
            disabled={!selectedRow || !canPurchase}
          >
            {buyText}
          </button>
        </div>
      </div>

      {/* QR overlay */}
      {qrVisible && (
        <div
          className={`sub-qr-overlay ${qrClosing ? "sub-qr-overlay--closing" : ""}`}
          onClick={(e) => e.target === e.currentTarget && closeQr()}
        >
          <div className={`sub-qr-card ${qrClosing ? "sub-qr-card--closing" : ""}`}>
            <div className="sub-qr-card__title">
              {t(isRenewal ? "subscription_qr_renew_title" : "subscription_qr_title")}
            </div>
            <div className="sub-qr-card__qr">
              <QRCodeSVG value={qrUrl} size={220} level="M" />
            </div>
            <div className="sub-qr-card__hint">
              {t(isRenewal ? "subscription_qr_renew_hint" : "subscription_qr_hint")}
            </div>
            <div className="sub-qr-card__hint">{t("subscription_sync_hint")}</div>
            {openError && (
              <div className="sub-qr-card__hint sub-qr-card__hint--error">
                {openError}
              </div>
            )}
            <button className="sub-qr-card__close" onClick={closeQr}>
              {t("subscription_change_plan")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
