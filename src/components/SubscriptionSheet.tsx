import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t, tf, getSavedLang, type StringKey } from "../i18n";
import {
  fetchPurchasePlans,
  markPendingPurchaseStarted,
  pingHwidOnly,
  startPendingPurchaseRefreshIfNeeded,
  sanitizePurchasePlansData,
} from "../session/auth";
import { useSession, type UserPlan } from "../session/store";
import { getCurrentPlan } from "../api/client";
import type { CurrentPlanDto, PurchaseDurationDto, PurchasePlanDto, PurchasePlansDto } from "../api/types";
import { formatDateDots } from "../session/dateFormat";
import { isBrowserPreviewRuntime } from "../session/browserPreview";
import Spinner from "./Spinner";
import "./SubscriptionSheet.css";

interface CurrentLimits {
  trafficLimitBytes: number;
  deviceLimit: number;
  renewalUrl: string | null;
}

function normalizePlanTrafficLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  if (value <= 0) return 0;
  return value > 1024 * 1024 ? value : value * 1024 * 1024 * 1024;
}

function currentLimitsFromPlan(dto: CurrentPlanDto | null | undefined): CurrentLimits | null {
  if (!dto) return null;
  const snapshot = dto.current_plan ?? dto.plan_snapshot ?? null;
  const subscription = dto.subscription ?? null;
  const renewalUrl = safePaymentUrl(dto.renewal_url);
  const trafficLimitBytes =
    subscription?.traffic_limit_bytes ??
    normalizePlanTrafficLimit(subscription?.traffic_limit) ??
    snapshot?.traffic_limit_bytes ??
    normalizePlanTrafficLimit(snapshot?.traffic_limit);
  const rawDeviceLimit = subscription?.device_limit ?? snapshot?.device_limit;
  const deviceLimit = Number.isSafeInteger(rawDeviceLimit) && (rawDeviceLimit ?? -1) >= 0
    ? Math.min(rawDeviceLimit ?? 0, 10_000)
    : null;
  if (trafficLimitBytes === null && deviceLimit === null && !renewalUrl) return null;
  return {
    trafficLimitBytes:
      Number.isFinite(trafficLimitBytes) && (trafficLimitBytes ?? -1) >= 0
        ? Math.min(trafficLimitBytes ?? 0, Number.MAX_SAFE_INTEGER)
        : 0,
    deviceLimit: deviceLimit ?? 0,
    renewalUrl,
  };
}

function safePaymentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

interface TelegramOpenTargets {
  desktopUrl: string;
  browserUrl: string;
}

function telegramOpenTargets(value: string): TelegramOpenTargets | null {
  try {
    const browser = new URL(value);
    if (
      browser.protocol !== "https:" ||
      browser.hostname.toLocaleLowerCase("en-US") !== "t.me" ||
      browser.username ||
      browser.password ||
      browser.port
    ) return null;

    const pathParts = browser.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (pathParts.length !== 1 || !/^[A-Za-z0-9_]{5,64}$/.test(pathParts[0])) return null;

    const desktop = new URL("tg://resolve");
    desktop.searchParams.set("domain", pathParts[0]);
    // Purchase links currently use `start`; retain `startapp` as well for a
    // future Telegram Mini App flow without forwarding arbitrary parameters
    // into the local protocol handler.
    for (const key of ["start", "startapp"] as const) {
      const parameter = browser.searchParams.get(key);
      if (parameter) desktop.searchParams.set(key, parameter);
    }
    return { desktopUrl: desktop.toString(), browserUrl: browser.toString() };
  } catch {
    return null;
  }
}

const FALLBACK_PLAN_DURATIONS = [
  { days: 1, rubPrice: 15 },
  { days: 7, rubPrice: 65 },
  { days: 30, rubPrice: 200 },
  { days: 90, rubPrice: 500 },
  { days: 365, rubPrice: 1500 },
];
const LEGACY_PURCHASE_PLANS_CACHE_KEY = "tobevpn_purchase_plans_shape_v1";
const PURCHASE_PLANS_CACHE_KEY = "tobevpn_purchase_plans_shape_v2";
const PURCHASE_PLANS_CACHE_VERSION = 2;
const PURCHASE_PLANS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PURCHASE_PLANS_CACHE_MAX_BYTES = 512 * 1024;
const PURCHASE_PLANS_CACHE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const PREVIEW_PURCHASE_PLANS: PurchasePlansDto = {
  telegram_id: 100000001,
  effective_discount_percent: 10,
  plans: [
    createPreviewPlan(1, "Стандарт", 100, 3, 1),
    createPreviewPlan(2, "Оптимальный", 250, 5, 2),
    createPreviewPlan(3, "Максимальный", 500, 10, 3),
    createPreviewPlan(4, "Семейный доступ", 1000, 20, 4),
    createPreviewPlan(5, "Премиум безлимит", 0, 30, 5),
  ],
};

interface PlanRow {
  key: string;
  title: string;
  description: string;
  priceDisplay: string;
  originalPriceDisplay: string | null;
  discountPercent: number;
  paymentUrl: string | null;
}

interface PlanTab {
  key: string;
  title: string;
  periods: PlanRow[];
}

interface ExitingPeriods {
  id: number;
  tab: PlanTab;
  selectedKey: string | null;
  showCacheHint: boolean;
}

interface SheetDragState {
  pointerId: number;
  startY: number;
  offset: number;
  activated: boolean;
}

const SHEET_DRAG_ACTIVATION_PX = 9;

function createPreviewPlan(
  id: number,
  name: string,
  trafficLimit: number,
  deviceLimit: number,
  orderIndex: number,
): PurchasePlanDto {
  return {
    id,
    public_code: `preview-${id}`,
    name,
    description: null,
    type: "PAID",
    availability: "PUBLIC",
    purchase_type: id === 1 ? "RENEW" : "CHANGE",
    traffic_limit: trafficLimit,
    traffic_limit_strategy: "MONTH",
    device_limit: deviceLimit,
    tag: null,
    order_index: orderIndex,
    internal_squad_uuids: [],
    external_squad_uuid: null,
    durations: FALLBACK_PLAN_DURATIONS.map((duration, index) => {
      const multiplier = orderIndex + 1;
      const rub = duration.rubPrice * multiplier;
      return {
        id: id * 100 + index + 1,
        days: duration.days,
        order_index: index,
        bot_start_param: `preview_${id}_${duration.days}`,
        bot_payment_url: `https://t.me/preview_bot?start=preview_${id}_${duration.days}`,
        prices: [
          { currency: "RUB", amount: String(rub) },
          { currency: "USD", amount: (rub / 95).toFixed(2) },
          { currency: "XTR", amount: String(Math.round(rub / 1.3)) },
        ],
        payment_methods: [
          {
            gateway_type: "CRYPTOMUS",
            currency: "RUB",
            original_amount: String(rub),
            final_amount: String(Math.round(rub * 0.9)),
            discount_percent: 10,
          },
          {
            gateway_type: "TELEGRAM_STARS",
            currency: "XTR",
            original_amount: String(Math.round(rub / 1.3)),
            final_amount: String(Math.round((rub / 1.3) * 0.9)),
            discount_percent: 10,
          },
        ],
      };
    }),
  };
}

interface PurchasePlansCacheRecord {
  version: number;
  savedAt: number;
  data: unknown;
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function removeCachedPurchasePlans(): void {
  try {
    localStorage.removeItem(PURCHASE_PLANS_CACHE_KEY);
    localStorage.removeItem(LEGACY_PURCHASE_PLANS_CACHE_KEY);
  } catch {
    // Storage is optional.
  }
}

function readCachedPurchasePlans(expectedTelegramId: number | null): PurchasePlansDto | null {
  try {
    // v1 was neither identity-scoped nor time-bounded and could contain a
    // reusable payment link. It must never be consumed again.
    localStorage.removeItem(LEGACY_PURCHASE_PLANS_CACHE_KEY);
    if (
      expectedTelegramId === null ||
      !Number.isSafeInteger(expectedTelegramId) ||
      expectedTelegramId <= 0
    ) return null;
    const raw = localStorage.getItem(PURCHASE_PLANS_CACHE_KEY);
    if (!raw) return null;
    if (
      raw.length > PURCHASE_PLANS_CACHE_MAX_BYTES ||
      encodedByteLength(raw) > PURCHASE_PLANS_CACHE_MAX_BYTES
    ) {
      removeCachedPurchasePlans();
      return null;
    }
    const record = JSON.parse(raw) as Partial<PurchasePlansCacheRecord>;
    const now = Date.now();
    if (
      record.version !== PURCHASE_PLANS_CACHE_VERSION ||
      !Number.isSafeInteger(record.savedAt) ||
      (record.savedAt ?? 0) > now + PURCHASE_PLANS_CACHE_FUTURE_TOLERANCE_MS ||
      now - (record.savedAt ?? 0) > PURCHASE_PLANS_CACHE_TTL_MS
    ) {
      removeCachedPurchasePlans();
      return null;
    }
    const data = sanitizePurchasePlansData(record.data, expectedTelegramId);
    if (!data || data.plans.length === 0) {
      removeCachedPurchasePlans();
      return null;
    }
    return data;
  } catch {
    removeCachedPurchasePlans();
    return null;
  }
}

function writeCachedPurchasePlans(
  data: PurchasePlansDto | null,
  expectedTelegramId: number | null,
): void {
  try {
    const sanitized = sanitizePurchasePlansData(data, expectedTelegramId);
    if (!sanitized || sanitized.plans.length === 0) return;
    // The cache exists only to render a degraded, masked plan list. Payment
    // actions must always come from a fresh authenticated response.
    const displayOnly: PurchasePlansDto = {
      ...sanitized,
      plans: sanitized.plans.map((plan) => ({
        ...plan,
        durations: plan.durations.map((duration) => ({
          ...duration,
          bot_start_param: null,
          bot_payment_url: null,
          payment_methods: [],
        })),
      })),
    };
    const raw = JSON.stringify({
      version: PURCHASE_PLANS_CACHE_VERSION,
      savedAt: Date.now(),
      data: displayOnly,
    } satisfies PurchasePlansCacheRecord);
    if (
      raw.length > PURCHASE_PLANS_CACHE_MAX_BYTES ||
      encodedByteLength(raw) > PURCHASE_PLANS_CACHE_MAX_BYTES
    ) return;
    localStorage.setItem(PURCHASE_PLANS_CACHE_KEY, raw);
    localStorage.removeItem(LEGACY_PURCHASE_PLANS_CACHE_KEY);
  } catch {
    // The live response is enough; cache failure should not block the sheet.
  }
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

function formatCurrency(amount: string, currency: string): string {
  switch (currency.trim().toLocaleUpperCase("en-US")) {
    case "RUB": return formatRub(amount);
    case "USD": return formatUsd(amount);
    case "XTR": return formatStars(amount);
    default: return `${amount} ${currency}`.trim();
  }
}

interface ResolvedDurationPrice {
  priceDisplay: string;
  originalPriceDisplay: string | null;
  discountPercent: number;
}

function resolveDurationPrice(
  duration: PurchaseDurationDto,
  isRu: boolean,
): ResolvedDurationPrice {
  // Keep the same server-price priority as Android. The amount itself is
  // always taken from payment_methods[].final_amount; the client never
  // recalculates a discount or its currency conversion.
  const preferredCurrencies = isRu ? ["RUB", "USD", "XTR"] : ["USD", "RUB", "XTR"];
  const methods = duration.payment_methods.filter(
    (method) =>
      method.currency.trim() &&
      method.original_amount.trim() &&
      method.final_amount.trim(),
  );
  const method = preferredCurrencies
    .map((currency) =>
      methods.find((candidate) => candidate.currency.toLocaleUpperCase("en-US") === currency),
    )
    .find((candidate) => candidate !== undefined) ?? methods[0];
  if (method) {
    const original = Number(method.original_amount);
    const final = Number(method.final_amount);
    const discountPercent = Math.min(100, Math.max(0, Math.trunc(method.discount_percent)));
    const hasDiscount =
      discountPercent > 0 &&
      Number.isFinite(original) &&
      Number.isFinite(final) &&
      final < original;
    return {
      priceDisplay: formatCurrency(method.final_amount, method.currency),
      originalPriceDisplay: hasDiscount
        ? formatCurrency(method.original_amount, method.currency)
        : null,
      discountPercent: hasDiscount ? discountPercent : 0,
    };
  }

  const prices = duration.prices.filter(
    (price) => price.currency.trim() && price.amount.trim(),
  );
  const price = preferredCurrencies
    .map((currency) =>
      prices.find((candidate) => candidate.currency.toLocaleUpperCase("en-US") === currency),
    )
    .find((candidate) => candidate !== undefined) ?? prices[0];
  return price
    ? {
        priceDisplay: formatCurrency(price.amount, price.currency),
        originalPriceDisplay: null,
        discountPercent: 0,
      }
    : {
        priceDisplay: t("plan_unknown_name"),
        originalPriceDisplay: null,
        discountPercent: 0,
      };
}

function planDescription(plan: PurchasePlanDto | null, masked = false): string {
  if (masked) return `${t("plan_quota_month")} · ${t("plan_devices_unknown")}`;
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

function buildTabs(data: PurchasePlansDto | null, isRu: boolean, masked = false): PlanTab[] {
  const sourcePlans = data
    ? data.plans
        .filter((p) => p.durations.some((d) => d.days > 0))
        .sort((a, b) => a.order_index - b.order_index || a.name.localeCompare(b.name))
    : [];
  if (sourcePlans.length === 0) {
    const desc = planDescription(null, true);
    return [
      {
        key: "fallback",
        title: t("plan_unknown_name"),
        periods: FALLBACK_PLAN_DURATIONS.map((d) => ({
          key: `fallback:${planKey(d.days)}`,
          title: planTitle(d.days),
          description: desc,
          priceDisplay: masked ? t("plan_unknown_name") : formatFallbackPrice(d.rubPrice, isRu),
          originalPriceDisplay: null,
          discountPercent: 0,
          paymentUrl: null,
        })),
      },
    ];
  }
  return sourcePlans.map((sourcePlan) => {
    const desc = planDescription(sourcePlan, masked);
    return {
      key: String(sourcePlan.id),
      title: sourcePlan.name,
      periods: [...sourcePlan.durations]
        .filter((d) => d.days > 0)
        .sort((a, b) => a.order_index - b.order_index)
        .map((d) => {
          const price = masked
            ? {
                priceDisplay: t("plan_unknown_name"),
                originalPriceDisplay: null,
                discountPercent: 0,
              }
            : resolveDurationPrice(d, isRu);
          return {
            key: `${sourcePlan.id}:${planKey(d.days)}`,
            title: planTitle(d.days),
            description: desc,
            ...price,
            paymentUrl: masked ? null : safePaymentUrl(d.bot_payment_url),
          };
        }),
    };
  });
}

function normalizedPlanName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function samePlanName(current: string | null | undefined, selected: string | null | undefined): boolean {
  const currentName = normalizedPlanName(current);
  const selectedName = normalizedPlanName(selected);
  if (!currentName || !selectedName) return false;
  return (
    currentName === selectedName ||
    currentName.startsWith(`${selectedName} `) ||
    selectedName.startsWith(`${currentName} `)
  );
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

export function SubscriptionCurrentPlanCard({
  currentPlanName,
  currentPlanNameClass,
  currentHint,
  showLimits,
  limitsLoading,
  trafficLimitValue,
  deviceLimitValue,
}: {
  currentPlanName: string;
  currentPlanNameClass: string;
  currentHint: string | null;
  showLimits: boolean;
  limitsLoading: boolean;
  trafficLimitValue: string;
  deviceLimitValue: string;
}) {
  return (
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
  );
}

export default function SubscriptionSheet({ onDismiss }: { onDismiss: () => void }) {
  const session = useSession();
  const isRu = getSavedLang() === "ru";
  const showLimits = session.userPlan === "PAID" || session.userPlan === "ADMIN";
  const currentLimitsKey =
    session.isLinked && session.telegramId !== null
      ? JSON.stringify([
          session.deviceId,
          session.telegramId,
          session.shortUuid ?? "",
          session.panelUserUuid ?? "",
          session.userPlan,
          session.planExpiresAt,
        ])
      : null;

  const [plansData, setPlansData] = useState<PurchasePlansDto | null>(null);
  const [plansFromCache, setPlansFromCache] = useState(false);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansRefreshing, setPlansRefreshing] = useState(true);
  const [currentLimits, setCurrentLimits] = useState<CurrentLimits | null>(null);
  const [loadedLimitsKey, setLoadedLimitsKey] = useState<string | null>(null);
  const [selectedTabKey, setSelectedTabKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [qrVisible, setQrVisible] = useState(false);
  const [qrClosing, setQrClosing] = useState(false);
  const [qrPaymentUrl, setQrPaymentUrl] = useState<string | null>(null);
  const [qrIsRenewal, setQrIsRenewal] = useState(false);
  const [purchaseOpening, setPurchaseOpening] = useState(false);
  const [telegramOpening, setTelegramOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const periodsContentRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetDragRef = useRef<SheetDragState | null>(null);
  const sheetSnapTimerRef = useRef<number | null>(null);
  const qrClosingRef = useRef(false);
  const sheetClosingRef = useRef(false);
  const purchaseOpeningRef = useRef(false);
  const telegramOpeningRef = useRef(false);
  const purchaseAttemptRef = useRef(0);
  const qrCloseTimerRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const tabTransitionIdRef = useRef(0);
  const tabTransitionTimerRef = useRef<number | null>(null);
  const tabsScrollerRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const tabsScrollAnimationRef = useRef<number | null>(null);
  const [periodsHeight, setPeriodsHeight] = useState<number | null>(null);
  const [exitingPeriods, setExitingPeriods] = useState<ExitingPeriods | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState({
    scrollable: false,
    start: false,
    end: false,
  });

  const closeQr = () => {
    if (qrClosingRef.current) return;
    qrClosingRef.current = true;
    setQrClosing(true);
    qrCloseTimerRef.current = window.setTimeout(() => {
      setQrVisible(false);
      setQrClosing(false);
      setQrPaymentUrl(null);
      setOpenError(null);
      qrClosingRef.current = false;
      qrCloseTimerRef.current = null;
    }, 180);
  };

  useEffect(() => {
    if (isBrowserPreviewRuntime()) {
      setPlansData(PREVIEW_PURCHASE_PLANS);
      setPlansFromCache(false);
      setPlansLoading(false);
      setPlansRefreshing(false);
      return;
    }

    const telegramId =
      session.isLinked && session.telegramId !== null ? session.telegramId : null;
    let cancelled = false;
    if (telegramId === null) {
      setPlansData(null);
      setPlansFromCache(false);
      setPlansLoading(false);
      setPlansRefreshing(false);
      return;
    }
    // Render the account-scoped, display-only cache immediately. Fresh prices,
    // discounts and payment links still always come from the live response.
    const cachedAtStart = readCachedPurchasePlans(telegramId);
    setPlansData(cachedAtStart);
    setPlansFromCache(Boolean(cachedAtStart));
    setPlansLoading(!cachedAtStart);
    setPlansRefreshing(true);
    fetchPurchasePlans()
      .then((data) => {
        if (cancelled) return;
        if (data && data.plans.length > 0) {
          writeCachedPurchasePlans(data, telegramId);
          setPlansData(data);
          setPlansFromCache(false);
          return;
        }
        const cached = cachedAtStart ?? readCachedPurchasePlans(telegramId);
        setPlansData(cached);
        setPlansFromCache(Boolean(cached));
      })
      .catch(() => {
        if (cancelled) return;
        const cached = cachedAtStart ?? readCachedPurchasePlans(telegramId);
        setPlansData(cached);
        setPlansFromCache(Boolean(cached));
      })
      .finally(() => {
        if (!cancelled) {
          setPlansLoading(false);
          setPlansRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    session.deviceId,
    session.isLinked,
    session.telegramId,
  ]);

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

  const tabs = useMemo(
    () => (plansLoading ? [] : buildTabs(plansData, isRu, plansFromCache || !plansData)),
    [plansData, plansFromCache, plansLoading, isRu],
  );

  const updateTabsOverflow = useCallback(() => {
    const scroller = tabsScrollerRef.current;
    if (!scroller) {
      setTabsOverflow((current) =>
        current.scrollable || current.start || current.end
          ? { scrollable: false, start: false, end: false }
          : current,
      );
      return;
    }

    const scrollable = scroller.scrollWidth > scroller.clientWidth + 1;
    const start = scrollable && scroller.scrollLeft > 1;
    const end = scrollable && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    setTabsOverflow((current) =>
      current.scrollable === scrollable && current.start === start && current.end === end
        ? current
        : { scrollable, start, end },
    );
  }, []);

  const animateTabsScrollTo = useCallback((target: number) => {
    const scroller = tabsScrollerRef.current;
    if (!scroller) return;

    if (tabsScrollAnimationRef.current !== null) {
      window.cancelAnimationFrame(tabsScrollAnimationRef.current);
      tabsScrollAnimationRef.current = null;
    }

    const start = scroller.scrollLeft;
    const distance = target - start;
    if (Math.abs(distance) <= 1) {
      scroller.scrollLeft = target;
      updateTabsOverflow();
      return;
    }

    const durationMs = 520;
    const startedAt = window.performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
      scroller.scrollLeft = start + distance * eased;
      if (progress < 1) {
        tabsScrollAnimationRef.current = window.requestAnimationFrame(animate);
      } else {
        tabsScrollAnimationRef.current = null;
        updateTabsOverflow();
      }
    };

    tabsScrollAnimationRef.current = window.requestAnimationFrame(animate);
  }, [updateTabsOverflow]);

  const scrollTabTowardCenter = useCallback((tabKey: string) => {
    const scroller = tabsScrollerRef.current;
    const tabButton = tabButtonRefs.current.get(tabKey);
    if (!scroller || !tabButton) return;

    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    if (maxScroll <= 1) return;

    const selectedStart = tabButton.offsetLeft;
    const selectedWidth = tabButton.offsetWidth;
    const selectedEnd = selectedStart + selectedWidth;
    const selectedCenter = selectedStart + selectedWidth / 2;
    const visibleStart = scroller.scrollLeft;
    const visibleEnd = visibleStart + scroller.clientWidth;
    const edgeComfort = Math.max(scroller.clientWidth / 4, selectedWidth / 2);
    const centeredTarget = selectedCenter - scroller.clientWidth / 2;

    let target = visibleStart;
    if (
      selectedStart < visibleStart ||
      selectedEnd > visibleEnd ||
      selectedCenter < visibleStart + edgeComfort ||
      selectedCenter > visibleEnd - edgeComfort
    ) {
      target = Math.min(maxScroll, Math.max(0, centeredTarget));
    }

    if (Math.abs(target - visibleStart) > 1) {
      animateTabsScrollTo(target);
    }
  }, [animateTabsScrollTo]);

  useEffect(() => {
    const scroller = tabsScrollerRef.current;
    if (!scroller || tabs.length === 0) {
      updateTabsOverflow();
      return;
    }

    let frame = window.requestAnimationFrame(updateTabsOverflow);
    const scheduleUpdate = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateTabsOverflow);
    };

    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scroller);
    Array.from(scroller.children).forEach((child) => observer.observe(child));
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", scheduleUpdate);
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [tabs, updateTabsOverflow]);

  // Keep the selection valid as the plan shape refreshes.
  useEffect(() => {
    if (tabs.length === 0) return;
    const activeTab = tabs.find((tab) => tab.key === selectedTabKey) ?? tabs[0];
    if (!selectedTabKey || activeTab.key !== selectedTabKey) {
      setSelectedTabKey(activeTab.key);
    }
    if (!selectedKey || !activeTab.periods.some((r) => r.key === selectedKey)) {
      const monthRow =
        activeTab.periods.find((r) => r.key === "month" || r.key.endsWith(":month")) ??
        activeTab.periods[0];
      setSelectedKey(monthRow?.key ?? null);
    }
  }, [tabs, selectedKey, selectedTabKey]);

  const selectedTab = useMemo(
    () => tabs.find((tab) => tab.key === selectedTabKey) ?? tabs[0] ?? null,
    [tabs, selectedTabKey],
  );
  const selectedRow = useMemo(
    () => selectedTab?.periods.find((r) => r.key === selectedKey) ?? selectedTab?.periods[0] ?? null,
    [selectedKey, selectedTab],
  );

  useEffect(() => {
    if (plansLoading || !selectedTab) {
      setPeriodsHeight(null);
      return;
    }

    const node = periodsContentRef.current;
    if (!node) return;

    let frame = 0;
    const updateHeight = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const nextHeight = node.scrollHeight;
        setPeriodsHeight((currentHeight) =>
          currentHeight === nextHeight ? currentHeight : nextHeight,
        );
      });
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [plansLoading, selectedTab?.key, plansFromCache]);

  const clearSheetSnapTimer = () => {
    if (sheetSnapTimerRef.current !== null) {
      window.clearTimeout(sheetSnapTimerRef.current);
      sheetSnapTimerRef.current = null;
    }
  };

  const resetSheetDragVisual = () => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.classList.remove("sub-sheet--dragging", "sub-sheet--snapping");
    sheet.style.removeProperty("transform");
    sheet.style.removeProperty("--sub-sheet-close-from");
    sheet.style.removeProperty("--sub-sheet-snap-duration");
  };

  const startSheetDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || closing || sheetClosingRef.current || qrVisible) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    clearSheetSnapTimer();
    resetSheetDragVisual();
    sheetDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      offset: 0,
      activated: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveSheetDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = sheetDragRef.current;
    const sheet = sheetRef.current;
    if (!drag || !sheet || drag.pointerId !== event.pointerId) return;
    const rawOffset = Math.min(
      sheet.offsetHeight,
      Math.max(0, event.clientY - drag.startY),
    );
    if (!drag.activated) {
      if (rawOffset < SHEET_DRAG_ACTIVATION_PX) {
        drag.offset = 0;
        return;
      }
      drag.activated = true;
      // Once the user has started interacting, the entrance animation must
      // never become active again. Otherwise removing the temporary drag/snap
      // class makes CSS replay slide-up and the sheet appears to blink open.
      sheet.classList.add("sub-sheet--settled", "sub-sheet--dragging");
    }
    drag.offset = rawOffset;
    sheet.style.transform = `translateY(${drag.offset}px)`;
    event.preventDefault();
  };

  const finishSheetDrag = (
    event: React.PointerEvent<HTMLElement>,
    allowClose: boolean,
  ) => {
    const drag = sheetDragRef.current;
    const sheet = sheetRef.current;
    if (!drag || !sheet || drag.pointerId !== event.pointerId) return;
    sheetDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    // A click or a tiny hand/mouse wobble never enters visual drag mode, so it
    // must not interrupt the sheet's opening animation or start a snap-back.
    if (!drag.activated) {
      resetSheetDragVisual();
      return;
    }

    const closeThreshold = Math.min(150, Math.max(76, sheet.offsetHeight * 0.18));
    // The boundary is authoritative: speed alone must never close the sheet.
    // Releasing anywhere above it always springs back from that exact point.
    const shouldClose = allowClose && drag.offset >= closeThreshold;
    sheet.classList.remove("sub-sheet--dragging");
    if (shouldClose) {
      sheet.style.setProperty("--sub-sheet-close-from", `${drag.offset}px`);
      sheet.style.removeProperty("transform");
      handleClose();
      return;
    }

    if (drag.offset <= 0) {
      resetSheetDragVisual();
      return;
    }
    sheet.classList.add("sub-sheet--snapping");
    const snapDuration = Math.round(
      Math.min(310, Math.max(210, 175 + drag.offset * 0.72)),
    );
    sheet.style.setProperty("--sub-sheet-snap-duration", `${snapDuration}ms`);
    // Commit the released position before assigning the destination. Without
    // this layout boundary WebKit can merge both writes into one frame and the
    // sheet appears to jerk instead of returning smoothly.
    void sheet.offsetHeight;
    sheet.style.transform = "translateY(0px)";
    sheetSnapTimerRef.current = window.setTimeout(() => {
      sheetSnapTimerRef.current = null;
      if (!sheetDragRef.current && !sheetClosingRef.current) resetSheetDragVisual();
    }, snapDuration + 32);
  };

  const handleClose = () => {
    if (sheetClosingRef.current) return;
    clearSheetSnapTimer();
    sheetDragRef.current = null;
    sheetClosingRef.current = true;
    purchaseAttemptRef.current += 1;
    purchaseOpeningRef.current = false;
    setClosing(true);
    dismissTimerRef.current = window.setTimeout(() => onDismiss(), 300);
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

  useEffect(() => {
    return () => {
      purchaseAttemptRef.current += 1;
      purchaseOpeningRef.current = false;
      telegramOpeningRef.current = false;
      if (tabTransitionTimerRef.current !== null) {
        window.clearTimeout(tabTransitionTimerRef.current);
      }
      if (qrCloseTimerRef.current !== null) {
        window.clearTimeout(qrCloseTimerRef.current);
      }
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
      if (tabsScrollAnimationRef.current !== null) {
        window.cancelAnimationFrame(tabsScrollAnimationRef.current);
        tabsScrollAnimationRef.current = null;
      }
      clearSheetSnapTimer();
      sheetDragRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!selectedTabKey) return;
    const frame = window.requestAnimationFrame(() => scrollTabTowardCenter(selectedTabKey));
    return () => window.cancelAnimationFrame(frame);
  }, [scrollTabTowardCenter, selectedTabKey, tabs.length]);

  const canPurchase = session.isLinked && session.telegramId !== null;
  const isPaidAccount = session.userPlan !== "FREE_TRIAL";
  const selectedTabIsCurrent = samePlanName(session.planDisplayName, selectedTab?.title);
  const isRenewal = isPaidAccount && selectedTabIsCurrent;
  const selectedActionTitle =
    selectedTab && selectedRow
      ? `${selectedTab.title} · ${selectedRow.title}`
      : selectedRow?.title ?? "";
  const selectedPaymentUrl =
    selectedRow?.paymentUrl ??
    (isRenewal && !plansFromCache ? currentLimits?.renewalUrl ?? null : null);
  const qrTelegramTargets = qrPaymentUrl ? telegramOpenTargets(qrPaymentUrl) : null;
  const handleOpenTelegram = async () => {
    if (!qrTelegramTargets || telegramOpeningRef.current || qrClosingRef.current) return;
    telegramOpeningRef.current = true;
    setTelegramOpening(true);
    setOpenError(null);
    try {
      if (isBrowserPreviewRuntime()) {
        window.open(qrTelegramTargets.browserUrl, "_blank", "noopener,noreferrer");
        return;
      }
      try {
        await openUrl(qrTelegramTargets.desktopUrl);
      } catch {
        await openUrl(qrTelegramTargets.browserUrl);
      }
    } catch {
      setOpenError(t("subscription_telegram_open_failed"));
    } finally {
      telegramOpeningRef.current = false;
      setTelegramOpening(false);
    }
  };
  const handleShowQr = async () => {
    if (purchaseOpeningRef.current || sheetClosingRef.current) return;
    if (!canPurchase) {
      setOpenError(t("not_authorized"));
      return;
    }
    if (!selectedRow) return;
    if (!selectedPaymentUrl) {
      setOpenError(t("plans_load_error"));
      return;
    }
    const paymentUrl = selectedPaymentUrl;
    const renewal = isRenewal;
    const attempt = ++purchaseAttemptRef.current;
    purchaseOpeningRef.current = true;
    setPurchaseOpening(true);
    setOpenError(null);
    try {
      if (await pingHwidOnly().catch(() => false)) {
        if (attempt === purchaseAttemptRef.current && !sheetClosingRef.current) {
          purchaseAttemptRef.current += 1;
          purchaseOpeningRef.current = false;
          setPurchaseOpening(false);
          handleClose();
        }
        return;
      }
      if (attempt !== purchaseAttemptRef.current || sheetClosingRef.current) return;
      markPendingPurchaseStarted({
        baselinePlan: session.userPlan,
        baselineExpiresAt: session.planExpiresAt,
      });
      startPendingPurchaseRefreshIfNeeded();
      setQrPaymentUrl(paymentUrl);
      setQrIsRenewal(renewal);
      setQrVisible(true);
    } finally {
      if (attempt === purchaseAttemptRef.current) {
        purchaseOpeningRef.current = false;
        setPurchaseOpening(false);
      }
    }
  };
  const buyText = selectedRow
    ? canPurchase
      ? tf(
          isRenewal ? "renew_plan" : isPaidAccount ? "change_plan" : "buy_plan",
          selectedActionTitle,
          selectedRow.priceDisplay,
        )
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
  const deviceLimitValue = deviceLimit !== null ? String(deviceLimit) : "XX";
  const appliedDiscountPercent =
    !plansFromCache && plansData
      ? Math.min(
          100,
          Math.max(0, Math.trunc(plansData.effective_discount_percent)),
        )
      : 0;
  // When cached tariffs are already visible, reserve the exact banner height
  // while fresh account-specific prices are loading. Otherwise the discount
  // banner is inserted later and makes the whole tariff list jump down.
  const discountPending =
    !plansLoading && plansRefreshing && plansFromCache;
  const discountVisible = discountPending || appliedDiscountPercent > 0;
  const selectTab = (tab: PlanTab) => {
    if (selectedTab?.key === tab.key) {
      scrollTabTowardCenter(tab.key);
      return;
    }

    if (selectedTab) {
      tabTransitionIdRef.current += 1;
      setExitingPeriods({
        id: tabTransitionIdRef.current,
        tab: selectedTab,
        selectedKey,
        showCacheHint: plansFromCache,
      });
      if (tabTransitionTimerRef.current !== null) {
        window.clearTimeout(tabTransitionTimerRef.current);
      }
      tabTransitionTimerRef.current = window.setTimeout(() => {
        setExitingPeriods(null);
        tabTransitionTimerRef.current = null;
      }, 360);
    }

    setSelectedTabKey(tab.key);
    const nextRow =
      tab.periods.find((row) => row.key === "month" || row.key.endsWith(":month")) ??
      tab.periods[0] ??
      null;
    setSelectedKey(nextRow?.key ?? null);
  };

  const renderPeriodRows = (
    periods: PlanRow[],
    activeKey: string | null,
    interactive: boolean,
  ) => periods.map((row) => (
    <div
      key={row.key}
      className={`sub-plan ${activeKey === row.key ? "sub-plan--selected" : ""}`}
      onClick={interactive ? () => setSelectedKey(row.key) : undefined}
    >
      <div className="sub-plan__radio">
        {activeKey === row.key && <div className="sub-plan__radio-dot" />}
      </div>
      <div className="sub-plan__info">
        <div className="sub-plan__title">{row.title}</div>
        <div className="sub-plan__desc">{row.description}</div>
      </div>
      <div className="sub-plan__price-column">
        {row.originalPriceDisplay && row.discountPercent > 0 && (
          <div className="sub-plan__discount">
            <span className="sub-plan__original-price">{row.originalPriceDisplay}</span>
            <span className="sub-plan__discount-percent">−{row.discountPercent}%</span>
          </div>
        )}
        <div className="sub-plan__price">{row.priceDisplay}</div>
      </div>
    </div>
  ));

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
      <div
        ref={sheetRef}
        className={`sub-sheet ${closing ? "sub-sheet--closing" : ""}`}
      >
        <div
          className="sub-sheet__handle"
          onPointerDown={startSheetDrag}
          onPointerMove={moveSheetDrag}
          onPointerUp={(event) => finishSheetDrag(event, true)}
          onPointerCancel={(event) => finishSheetDrag(event, false)}
          aria-hidden="true"
        />
        <button
          type="button"
          className="sub-sheet__close"
          onClick={handleClose}
          aria-label={t("close")}
          title={t("close")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="sub-sheet__content">
          <div
            className="sub-sheet__title-row"
            onPointerDown={startSheetDrag}
            onPointerMove={moveSheetDrag}
            onPointerUp={(event) => finishSheetDrag(event, true)}
            onPointerCancel={(event) => finishSheetDrag(event, false)}
          >
            <div className="sub-sheet__title">{t("subscription")}</div>
          </div>

          {/* Current plan */}
          <SubscriptionCurrentPlanCard
            currentPlanName={currentPlanName}
            currentPlanNameClass={currentPlanNameClass}
            currentHint={currentHint}
            showLimits={showLimits}
            limitsLoading={limitsLoading}
            trafficLimitValue={trafficLimitValue}
            deviceLimitValue={deviceLimitValue}
          />

          <div className="sub-sheet__divider" />

          <div className="sub-sheet__section-title">{t("available_plans")}</div>

          <div
            className={`sub-discount-slot ${discountVisible ? "sub-discount-slot--visible" : ""}`}
            aria-hidden={!discountVisible || discountPending}
          >
            <div className="sub-discount-slot__inner">
              {discountPending ? (
                <div className="sub-discount-banner sub-discount-banner--loading">
                  <span className="sub-discount-banner__skeleton-icon" aria-hidden="true" />
                  <span className="sub-discount-banner__skeleton-line" aria-hidden="true" />
                </div>
              ) : appliedDiscountPercent > 0 ? (
                <div className="sub-discount-banner">
                  <span aria-hidden="true">%</span>
                  {tf("purchase_discount_applied", appliedDiscountPercent)}
                </div>
              ) : null}
            </div>
          </div>

          {plansLoading ? (
            <div className="sub-sheet__loading">
              <Spinner size={18} thickness={2} />
              <span>{t("plans_loading")}</span>
            </div>
          ) : tabs.length === 0 ? (
            <div className="sub-sheet__hint">{t("plans_load_error")}</div>
          ) : (
            <div className="sub-tariffs">
              <div
                className={`sub-tabs-shell ${tabsOverflow.start ? "sub-tabs-shell--start" : ""} ${tabsOverflow.end ? "sub-tabs-shell--end" : ""}`}
              >
                <div className="sub-tabs" ref={tabsScrollerRef}>
                  {tabs.map((tab) => (
                    <button
                      key={tab.key}
                      ref={(node) => {
                        if (node) tabButtonRefs.current.set(tab.key, node);
                        else tabButtonRefs.current.delete(tab.key);
                      }}
                      type="button"
                      className={`sub-tab ${selectedTab?.key === tab.key ? "sub-tab--selected" : ""}`}
                      onClick={() => selectTab(tab)}
                      disabled={purchaseOpening}
                      aria-pressed={selectedTab?.key === tab.key}
                    >
                      <span>{tab.title}</span>
                    </button>
                  ))}
                </div>
                <span className="sub-tabs__edge sub-tabs__edge--start" aria-hidden="true">‹</span>
                <span className="sub-tabs__edge sub-tabs__edge--end" aria-hidden="true">›</span>
              </div>

              <div
                className="sub-periods-shell"
                style={periodsHeight === null ? undefined : { height: `${periodsHeight}px` }}
              >
                {exitingPeriods && (
                  <div
                    key={`exit:${exitingPeriods.id}`}
                    className="sub-periods sub-periods--exit"
                    aria-hidden="true"
                  >
                    {renderPeriodRows(exitingPeriods.tab.periods, exitingPeriods.selectedKey, false)}
                    {exitingPeriods.showCacheHint && (
                      <div className="sub-sheet__hint sub-sheet__hint--compact">
                        {t("plans_load_error")}
                      </div>
                    )}
                  </div>
                )}
                <div
                  key={selectedTab?.key ?? "empty"}
                  ref={periodsContentRef}
                  className="sub-periods sub-periods--enter"
                >
                  {renderPeriodRows(selectedTab?.periods ?? [], selectedKey, !purchaseOpening)}
                  {plansFromCache && (
                    <div className="sub-sheet__hint sub-sheet__hint--compact">
                      {t("plans_load_error")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="sub-sheet__hint">{t("payment_via_telegram")}</div>

          <button
            className="sub-sheet__buy-btn"
            onClick={handleShowQr}
            disabled={purchaseOpening || !selectedRow || !canPurchase || !selectedPaymentUrl}
            aria-busy={purchaseOpening}
          >
            {buyText}
          </button>
        </div>
      </div>

      {/* QR overlay */}
      {qrVisible && qrPaymentUrl && (
        <div
          className={`sub-qr-overlay ${qrClosing ? "sub-qr-overlay--closing" : ""}`}
          onClick={(e) => e.target === e.currentTarget && closeQr()}
        >
          <div className={`sub-qr-card ${qrClosing ? "sub-qr-card--closing" : ""}`}>
            <div className="sub-qr-card__title">
              {t(qrIsRenewal ? "subscription_qr_renew_title" : "subscription_qr_title")}
            </div>
            <div className="sub-qr-card__qr">
              <QRCodeSVG value={qrPaymentUrl} size={220} level="M" />
            </div>
            <div className="sub-qr-card__hint">
              {t(qrIsRenewal ? "subscription_qr_renew_hint" : "subscription_qr_hint")}
            </div>
            <div className="sub-qr-card__hint">{t("subscription_sync_hint")}</div>
            {openError && (
              <div className="sub-qr-card__hint sub-qr-card__hint--error">
                {openError}
              </div>
            )}
            <div className="sub-qr-card__actions">
              {qrTelegramTargets && (
                <button
                  type="button"
                  className="sub-qr-card__telegram"
                  onClick={() => void handleOpenTelegram()}
                  disabled={telegramOpening}
                  aria-busy={telegramOpening}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M22 2 11 13" />
                    <path d="m22 2-7 20-4-9-9-4Z" />
                  </svg>
                  {t(telegramOpening ? "subscription_opening_telegram" : "subscription_open_telegram")}
                </button>
              )}
              <button type="button" className="sub-qr-card__close" onClick={closeQr}>
                {t("subscription_change_plan")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
