import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { ApiHttpError } from "../api/client";
import type {
  PromocodeActivationResultDto,
  PromocodeHistoryDto,
  PromocodeHistoryItemDto,
  PromocodePlanSnapshotDto,
} from "../api/types";
import MaterialIcon, {
  type MaterialIconName,
} from "../components/MaterialIcon";
import Spinner from "../components/Spinner";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import { useAnimatedDialogClose } from "../components/useAnimatedDialogClose";
import { getSavedLang, t, tf, type StringKey } from "../i18n";
import {
  fetchPurchasePlans,
  fetchVpnServers,
  syncSubscription,
} from "../session/auth";
import {
  applyPromocode,
  fetchPromocodeHistory,
  normalizePromocodeCode,
  PromocodeAuthenticationError,
  PromocodeResponseError,
} from "../session/promocodes";
import { useSession } from "../session/store";
import { recordDiagnosticEvent } from "../session/diagnostics";
import "./PromocodesScreen.css";

const PAGE_SIZE = 20;
const MIN_REFRESH_FEEDBACK_MS = 800;
const MAX_PROMOCODE_LENGTH = 128;

type LoadErrorKey =
  | "promocodes_load_error_network"
  | "promocodes_load_error_auth"
  | "promocodes_load_error_unavailable"
  | "promocodes_load_error_unknown";

type ActivationErrorKey =
  | "promocodes_activation_error_network"
  | "promocodes_activation_error_not_found"
  | "promocodes_activation_error_expired"
  | "promocodes_activation_error_already_activated"
  | "promocodes_activation_error_active_subscription"
  | "promocodes_activation_error_already_unlimited"
  | "promocodes_activation_error_limit"
  | "promocodes_activation_error_new_users"
  | "promocodes_activation_error_existing_users"
  | "promocodes_activation_error_invited_users"
  | "promocodes_activation_error_not_available"
  | "promocodes_activation_error_auth"
  | "promocodes_activation_error_too_many"
  | "promocodes_activation_error_unknown";

interface PromocodeData {
  total: number;
  items: PromocodeHistoryItemDto[];
}

interface RewardAppearance {
  icon: MaterialIconName;
  className: string;
}

const PREVIEW_ITEMS: PromocodeHistoryItemDto[] = [
  {
    activation_id: 1,
    promocode_id: 10,
    code: "WELCOME10",
    reward_type: "PERSONAL_DISCOUNT",
    reward: 10,
    activated_at: "2026-08-05T08:30:00Z",
  },
  {
    activation_id: 2,
    promocode_id: 11,
    code: "EXTRA7",
    reward_type: "DURATION",
    reward: 7,
    activated_at: "2026-07-30T14:15:00Z",
  },
];

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /network|failed to fetch|timed?\s*out|connection|dns|offline/i.test(message);
}

function toLoadError(error: unknown): LoadErrorKey {
  if (isNetworkFailure(error)) return "promocodes_load_error_network";
  if (error instanceof PromocodeAuthenticationError) {
    return "promocodes_load_error_auth";
  }
  if (error instanceof ApiHttpError) {
    if ([401, 403, 404].includes(error.status)) return "promocodes_load_error_auth";
    if (error.status >= 500) return "promocodes_load_error_unavailable";
  }
  if (error instanceof PromocodeResponseError) {
    return "promocodes_load_error_unavailable";
  }
  return "promocodes_load_error_unknown";
}

function parseStructuredServerError(error: ApiHttpError): {
  code: string;
  message: string;
} {
  try {
    const parsed = JSON.parse(error.message) as {
      detail?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const detail =
      parsed.detail && typeof parsed.detail === "object"
        ? (parsed.detail as Record<string, unknown>)
        : parsed;
    return {
      code: typeof detail.code === "string" ? detail.code.toLocaleUpperCase("en-US") : "",
      message: typeof detail.message === "string" ? detail.message.toLocaleLowerCase("en-US") : "",
    };
  } catch {
    return { code: "", message: error.message.toLocaleLowerCase("en-US") };
  }
}

function toActivationError(error: unknown): ActivationErrorKey {
  if (isNetworkFailure(error)) return "promocodes_activation_error_network";
  if (error instanceof PromocodeAuthenticationError) {
    return "promocodes_activation_error_auth";
  }
  if (!(error instanceof ApiHttpError)) {
    return "promocodes_activation_error_unknown";
  }

  const server = parseStructuredServerError(error);
  if (error.status === 401 || error.status === 403 || server.code === "USER_NOT_FOUND") {
    return "promocodes_activation_error_auth";
  }
  if (error.status === 429) return "promocodes_activation_error_too_many";
  if (server.code === "PROMOCODE_NOT_FOUND" || error.status === 404) {
    return "promocodes_activation_error_not_found";
  }
  if (server.code === "PROMOCODE_EXPIRED") {
    return "promocodes_activation_error_expired";
  }
  if (server.code === "PROMOCODE_ALREADY_ACTIVATED") {
    return "promocodes_activation_error_already_activated";
  }
  if (server.code === "PROMOCODE_NOT_AVAILABLE") {
    if (server.message.includes("active subscription required")) {
      return "promocodes_activation_error_active_subscription";
    }
    if (server.message.includes("already unlimited")) {
      return "promocodes_activation_error_already_unlimited";
    }
    if (server.message.includes("activation limit")) {
      return "promocodes_activation_error_limit";
    }
    if (server.message.includes("new users only")) {
      return "promocodes_activation_error_new_users";
    }
    if (server.message.includes("existing users only")) {
      return "promocodes_activation_error_existing_users";
    }
    if (server.message.includes("invited users only")) {
      return "promocodes_activation_error_invited_users";
    }
    return "promocodes_activation_error_not_available";
  }
  if (
    server.code === "PROMOCODE_INVALID" ||
    error.status === 400 ||
    error.status === 409
  ) {
    return "promocodes_activation_error_not_available";
  }
  return "promocodes_activation_error_unknown";
}

function itemKey(item: PromocodeHistoryItemDto): string {
  return item.activation_id !== null && item.activation_id !== undefined
    ? `activation:${item.activation_id}`
    : [item.promocode_id, item.code, item.reward_type, item.activated_at].join("\u0000");
}

function mergePages(current: PromocodeData, page: PromocodeHistoryDto): PromocodeData {
  const unique = new Map<string, PromocodeHistoryItemDto>();
  for (const item of [...current.items, ...(page.promocodes ?? [])]) {
    unique.set(itemKey(item), item);
  }
  return { total: page.total, items: [...unique.values()] };
}

function pluralKey(
  value: number,
  one: StringKey,
  few: StringKey,
  many: StringKey,
): StringKey {
  if (getSavedLang() !== "ru") return value === 1 ? one : many;
  const mod10 = Math.abs(value) % 10;
  const mod100 = Math.abs(value) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function rewardText(
  rewardType: string | null | undefined,
  reward: number | null | undefined,
  planSnapshot: PromocodePlanSnapshotDto | null | undefined,
): string {
  const type = (rewardType ?? "").toLocaleUpperCase("en-US");
  if (type === "DURATION") {
    if (reward === 0) return t("promocodes_reward_duration_unlimited");
    if (typeof reward === "number") {
      return tf(
        pluralKey(
          reward,
          "promocodes_reward_duration_one",
          "promocodes_reward_duration_few",
          "promocodes_reward_duration_many",
        ),
        reward,
      );
    }
  }
  if (type === "TRAFFIC") {
    if (reward === 0) return t("promocodes_reward_traffic_unlimited");
    if (typeof reward === "number") return tf("promocodes_reward_traffic", reward);
  }
  if (type === "DEVICES") {
    if (reward === 0) return t("promocodes_reward_devices_unlimited");
    if (typeof reward === "number") {
      return tf(
        pluralKey(
          reward,
          "promocodes_reward_devices_one",
          "promocodes_reward_devices_few",
          "promocodes_reward_devices_many",
        ),
        reward,
      );
    }
  }
  if (type === "SUBSCRIPTION") {
    const name = planSnapshot?.name?.trim() || t("promocodes_reward_subscription_unknown");
    const duration = planSnapshot?.duration;
    if (duration === 0) return tf("promocodes_reward_subscription_unlimited", name);
    if (typeof duration === "number") {
      const durationText = tf(
        pluralKey(
          duration,
          "promocodes_days_one",
          "promocodes_days_few",
          "promocodes_days_many",
        ),
        duration,
      );
      return tf("promocodes_reward_subscription_duration", name, durationText);
    }
    return tf("promocodes_reward_subscription", name);
  }
  if (type === "PERSONAL_DISCOUNT") {
    return tf("promocodes_reward_personal_discount", reward ?? 0);
  }
  if (type === "PURCHASE_DISCOUNT") {
    return tf("promocodes_reward_purchase_discount", reward ?? 0);
  }
  return t("promocodes_reward_applied");
}

function rewardAppearance(typeRaw: string | null | undefined): RewardAppearance {
  switch ((typeRaw ?? "").toLocaleUpperCase("en-US")) {
    case "DURATION": return { icon: "schedule", className: "green" };
    case "TRAFFIC": return { icon: "dataUsage", className: "blue" };
    case "DEVICES": return { icon: "devices", className: "purple" };
    case "SUBSCRIPTION": return { icon: "cardGiftcard", className: "orange" };
    case "PERSONAL_DISCOUNT": return { icon: "percent", className: "pink" };
    case "PURCHASE_DISCOUNT": return { icon: "percent", className: "yellow" };
    default: return { icon: "localOffer", className: "yellow" };
  }
}

function formatDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(getSavedLang() === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export default function PromocodesScreen({
  onBack,
  browserPreview = false,
}: {
  onBack: () => void;
  browserPreview?: boolean;
}) {
  const session = useSession();
  const authenticated = browserPreview || session.isLinked;
  const [data, setData] = useState<PromocodeData | null>(
    browserPreview ? { total: PREVIEW_ITEMS.length, items: PREVIEW_ITEMS } : null,
  );
  const dataRef = useRef<PromocodeData | null>(data);
  const requestSequenceRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const activationInFlightRef = useRef(false);
  const [discountPercent, setDiscountPercent] = useState(browserPreview ? 10 : 0);
  const [code, setCode] = useState("");
  const [isInitialLoading, setInitialLoading] = useState(!browserPreview && authenticated);
  const [isRefreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [isActivating, setActivating] = useState(false);
  const [loadError, setLoadError] = useState<LoadErrorKey | null>(null);
  const [activationError, setActivationError] = useState<ActivationErrorKey | null>(null);
  const [activationResult, setActivationResult] =
    useState<PromocodeActivationResultDto | null>(null);

  const commitData = useCallback((next: PromocodeData | null) => {
    dataRef.current = next;
    setData(next);
  }, []);

  const loadPage = useCallback(async (reset: boolean) => {
    if (requestInFlightRef.current || !authenticated) return;
    const existing = dataRef.current;
    if (!reset && (!existing || existing.items.length >= existing.total)) return;

    requestInFlightRef.current = true;
    const requestId = ++requestSequenceRef.current;
    const refreshStartedAt = reset && existing ? performance.now() : null;
    setLoadError(null);
    setInitialLoading(reset && existing === null);
    setRefreshing(reset && existing !== null);
    setLoadingMore(!reset);

    try {
      let page: PromocodeHistoryDto;
      let refreshedDiscount: number | null = null;
      if (browserPreview) {
        page = {
          telegram_id: 100000001,
          total: PREVIEW_ITEMS.length,
          limit: PAGE_SIZE,
          offset: 0,
          promocodes: PREVIEW_ITEMS,
        };
        refreshedDiscount = 10;
      } else {
        const offset = reset ? 0 : existing?.items.length ?? 0;
        const [history, plans] = await Promise.all([
          fetchPromocodeHistory(PAGE_SIZE, offset),
          reset ? fetchPurchasePlans().catch(() => null) : Promise.resolve(null),
        ]);
        page = history;
        refreshedDiscount = plans?.effective_discount_percent ?? null;
      }

      if (refreshStartedAt !== null) {
        const remaining = MIN_REFRESH_FEEDBACK_MS - (performance.now() - refreshStartedAt);
        if (remaining > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remaining));
        }
      }
      if (requestId !== requestSequenceRef.current) return;
      commitData(
        reset || !existing
          ? { total: page.total, items: page.promocodes ?? [] }
          : mergePages(existing, page),
      );
      if (refreshedDiscount !== null) {
        setDiscountPercent(Math.min(100, Math.max(0, Math.trunc(refreshedDiscount))));
      }
      recordDiagnosticEvent(
        "Promocodes",
        `Promocode history refreshed; page_items=${page.promocodes?.length ?? 0}, total=${page.total}, effective_discount=${refreshedDiscount ?? "unchanged"}`,
        "D",
      );
    } catch (error) {
      if (requestId !== requestSequenceRef.current) return;
      console.warn("[promocodes] history request failed", error);
      recordDiagnosticEvent("Promocodes", `Promocode history refresh failed: ${String(error)}`, "W");
      setLoadError(toLoadError(error));
    } finally {
      if (requestId === requestSequenceRef.current) {
        requestInFlightRef.current = false;
        setInitialLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [authenticated, browserPreview, commitData]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    requestInFlightRef.current = false;
    activationInFlightRef.current = false;
    setCode("");
    setActivationError(null);
    setActivationResult(null);
    setLoadError(null);
    if (browserPreview) {
      commitData({ total: PREVIEW_ITEMS.length, items: PREVIEW_ITEMS });
      setDiscountPercent(10);
      setInitialLoading(false);
      return;
    }
    commitData(null);
    setDiscountPercent(0);
    if (!session.isLinked) {
      setInitialLoading(false);
      return;
    }
    setInitialLoading(true);
    void loadPage(true);
    return () => {
      requestSequenceRef.current += 1;
      requestInFlightRef.current = false;
    };
  }, [browserPreview, commitData, loadPage, session.isLinked, session.telegramId]);

  const handleActivate = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizePromocodeCode(code);
    if (!normalized || activationInFlightRef.current || !authenticated) return;
    activationInFlightRef.current = true;
    setActivating(true);
    setActivationError(null);
    recordDiagnosticEvent("Promocodes", "Promocode activation requested");
    try {
      const result = browserPreview
        ? {
            request_id: crypto.randomUUID(),
            code: normalized,
            reward_type: "PERSONAL_DISCOUNT",
            reward: 10,
          }
        : await applyPromocode(normalized);
      setActivationResult(result);
      setCode("");

      const rewardType = (result.reward_type ?? "").toLocaleUpperCase("en-US");
      recordDiagnosticEvent(
        "Promocodes",
        `Promocode activated successfully; reward_type=${rewardType || "unknown"}, reward=${result.reward ?? "unknown"}`,
      );
      if (
        !browserPreview &&
        rewardType !== "PERSONAL_DISCOUNT" &&
        rewardType !== "PURCHASE_DISCOUNT"
      ) {
        await syncSubscription({ force: true }).catch(() => {});
        await fetchVpnServers({ skipAccessPing: true }).catch(() => []);
      }
      activationInFlightRef.current = false;
      setActivating(false);
      await loadPage(true);
    } catch (error) {
      console.warn("[promocodes] activation failed", error);
      const mappedError = toActivationError(error);
      recordDiagnosticEvent(
        "Promocodes",
        `Promocode activation failed; category=${mappedError}: ${String(error)}`,
        "W",
      );
      setActivationError(mappedError);
      activationInFlightRef.current = false;
      setActivating(false);
    }
  };

  const normalizedCode = normalizePromocodeCode(code);

  return (
    <div className="promocodes-root">
      <header className="promocodes-topbar">
        <button
          type="button"
          className="promocodes-topbar__back"
          onClick={onBack}
          aria-label={t("back")}
          title={t("back")}
        >
          <MaterialIcon name="arrowBack" size={23} />
        </button>
        <h1>{t("promocodes_title")}</h1>
        <TopbarRefreshButton
          label={t("refresh")}
          loading={isInitialLoading || isRefreshing}
          onClick={() => void loadPage(true)}
          disabled={
            !authenticated ||
            isInitialLoading ||
            isRefreshing ||
            isLoadingMore ||
            isActivating
          }
        />
      </header>

      <ScrollEdgeAffordance as="main" className="promocodes-content">
        {!authenticated ? (
          <CenteredState
            title={t("promocodes_auth_title")}
            description={t("promocodes_auth_description")}
          />
        ) : isInitialLoading && data === null ? (
          <div className="promocodes-loading">
            <Spinner size={30} thickness={3} className="spinner--accent" />
          </div>
        ) : data === null ? (
          <CenteredState
            title={t("promocodes_error_title")}
            description={t(loadError ?? "promocodes_load_error_unknown")}
            error
            action={
              <button
                type="button"
                className="promocodes-primary-button promocodes-centered__button"
                onClick={() => void loadPage(true)}
              >
                {t("referrals_retry")}
              </button>
            }
          />
        ) : (
          <>
            <form className="promocodes-activation-card" onSubmit={handleActivate}>
              <div className="promocodes-card-heading">
                <span className="promocodes-icon promocodes-icon--accent" aria-hidden="true">
                  <MaterialIcon name="localOffer" size={25} />
                </span>
                <div>
                  <h2>{t("promocodes_activate_title")}</h2>
                  <p>{t("promocodes_activate_description")}</p>
                </div>
              </div>

              <label className="promocodes-field">
                <span className="promocodes-field__label">{t("promocodes_code_label")}</span>
                <span className="promocodes-field__control">
                  <MaterialIcon name="localOffer" size={19} />
                  <input
                    value={code}
                    onChange={(event) => {
                      setCode(
                        event.currentTarget.value
                          .replace(/[\u0000-\u001f\u007f]/g, "")
                          .toLocaleUpperCase("en-US")
                          .slice(0, MAX_PROMOCODE_LENGTH),
                      );
                      setActivationError(null);
                    }}
                    placeholder={t("promocodes_code_placeholder")}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    disabled={isActivating}
                    aria-invalid={activationError !== null}
                  />
                  {code && !isActivating && (
                    <button
                      type="button"
                      className="promocodes-field__clear"
                      onClick={() => {
                        setCode("");
                        setActivationError(null);
                      }}
                      aria-label={t("promocodes_clear_code")}
                      title={t("promocodes_clear_code")}
                    >
                      ×
                    </button>
                  )}
                </span>
              </label>

              {activationError && (
                <p className="promocodes-field__error" role="alert">
                  {t(activationError)}
                </p>
              )}

              <button
                type="submit"
                className="promocodes-primary-button promocodes-activation-card__submit"
                disabled={!normalizedCode || isActivating}
              >
                {isActivating && <Spinner size={18} thickness={2} />}
                {t(isActivating ? "promocodes_activating" : "promocodes_activate_button")}
              </button>
            </form>

            {discountPercent > 0 && (
              <section className="promocodes-discount-card">
                <span className="promocodes-icon promocodes-icon--green" aria-hidden="true">%</span>
                <div>
                  <h2>{t("promocodes_current_discount_title")}</h2>
                  <p>{t("promocodes_current_discount_description")}</p>
                </div>
                <strong>{tf("promocodes_discount_value", discountPercent)}</strong>
              </section>
            )}

            <section className="promocodes-history-heading">
              <div>
                <MaterialIcon name="history" size={21} />
                <h2>{t("promocodes_history_title")}</h2>
                {data.total > 0 && <span>{data.total}</span>}
              </div>
              <p>{t("promocodes_history_description")}</p>
            </section>

            {isRefreshing ? (
              <HistorySkeleton />
            ) : data.items.length === 0 ? (
              <section className="promocodes-card promocodes-empty">
                <span className="promocodes-icon promocodes-icon--muted" aria-hidden="true">
                  <MaterialIcon name="localOffer" size={26} />
                </span>
                <div>
                  <h2>{t("promocodes_empty_title")}</h2>
                  <p>{t("promocodes_empty_description")}</p>
                </div>
              </section>
            ) : (
              <div className="promocodes-history-list">
                {data.items.map((item) => (
                  <HistoryCard key={itemKey(item)} item={item} />
                ))}
              </div>
            )}

            {loadError && data !== null && (
              <div className="promocodes-inline-error" role="alert">
                <span>{t(loadError)}</span>
                <button type="button" onClick={() => void loadPage(true)}>
                  {t("referrals_retry")}
                </button>
              </div>
            )}

            {data.items.length < data.total && (
              <button
                type="button"
                className="promocodes-outline-button"
                onClick={() => void loadPage(false)}
                disabled={isLoadingMore || isRefreshing || isActivating}
              >
                {isLoadingMore && <Spinner size={17} thickness={2} />}
                {t(isLoadingMore ? "promocodes_loading_more" : "promocodes_load_more")}
              </button>
            )}
          </>
        )}
      </ScrollEdgeAffordance>

      {activationResult && (
        <SuccessDialog result={activationResult} onDismiss={() => setActivationResult(null)} />
      )}
    </div>
  );
}

function HistoryCard({ item }: { item: PromocodeHistoryItemDto }) {
  const appearance = rewardAppearance(item.reward_type);
  const date = formatDate(item.activated_at);
  return (
    <article className="promocodes-card promocodes-history-card">
      <span
        className={`promocodes-icon promocodes-icon--${appearance.className}`}
        aria-hidden="true"
      >
        <MaterialIcon name={appearance.icon} size={23} />
      </span>
      <div>
        <h3>{item.code?.trim() || t("promocodes_unknown_code")}</h3>
        <p>{rewardText(item.reward_type, item.reward, item.plan_snapshot)}</p>
        {date && <small>{tf("promocodes_activated_at", date)}</small>}
      </div>
    </article>
  );
}

function CenteredState({
  title,
  description,
  action,
  error = false,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div className="promocodes-centered">
      <span
        className={`promocodes-icon ${error ? "promocodes-icon--error" : "promocodes-icon--accent"}`}
        aria-hidden="true"
      >
        <MaterialIcon name={error ? "cloudOff" : "localOffer"} size={40} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="promocodes-history-list promocodes-skeleton" aria-hidden="true">
      {[0, 1].map((index) => (
        <div className="promocodes-card promocodes-history-card" key={index}>
          <span className="promocodes-skeleton__icon" />
          <div>
            <span className="promocodes-skeleton__line" />
            <span className="promocodes-skeleton__line promocodes-skeleton__line--wide" />
            <span className="promocodes-skeleton__line promocodes-skeleton__line--small" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SuccessDialog({
  result,
  onDismiss,
}: {
  result: PromocodeActivationResultDto;
  onDismiss: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { closing, requestClose } = useAnimatedDialogClose(onDismiss);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => buttonRef.current?.focus());
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  const target = document.getElementById("overlay-root") ?? document.body;
  return createPortal(
    <div
      className={`promocodes-dialog-overlay ${closing ? "promocodes-dialog-overlay--closing" : ""}`}
      onClick={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        className={`promocodes-success-dialog ${closing ? "promocodes-success-dialog--closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="promocodes-success-title"
      >
        <span className="promocodes-success-dialog__icon" aria-hidden="true">
          <MaterialIcon name="localOffer" size={29} />
        </span>
        <h2 id="promocodes-success-title">{t("promocodes_success_title")}</h2>
        {result.code?.trim() && (
          <div className="promocodes-success-dialog__code">{result.code}</div>
        )}
        <p className="promocodes-success-dialog__reward">
          {rewardText(result.reward_type, result.reward, result.plan_snapshot)}
        </p>
        <p className="promocodes-success-dialog__description">
          {t("promocodes_success_description")}
        </p>
        <button
          ref={buttonRef}
          type="button"
          className="promocodes-primary-button"
          onClick={() => requestClose()}
        >
          {t("promocodes_done")}
        </button>
      </div>
    </div>,
    target,
  );
}
