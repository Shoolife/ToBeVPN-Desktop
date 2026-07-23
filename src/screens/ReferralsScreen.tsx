import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ApiHttpError,
  getReferrals,
  setReferrer,
} from "../api/client";
import type {
  ReferralListItemDto,
  ReferralsDto,
  ReferralUserDto,
} from "../api/types";
import CopyNotification, {
  useCopyNotification,
} from "../components/CopyNotification";
import MaterialIcon from "../components/MaterialIcon";
import Spinner from "../components/Spinner";
import TopbarRefreshButton from "../components/TopbarRefreshButton";
import { getSavedLang, t, tf, type StringKey } from "../i18n";
import { useSession } from "../session/store";
import "./ReferralsScreen.css";

const PAGE_SIZE = 20;
const MIN_REFRESH_FEEDBACK_MS = 900;
const SHEET_EXIT_MS = 240;
const MAX_TELEGRAM_ID_DIGITS = 19;

type ReferralData = {
  referralUrl: string;
  referrer: ReferralUserDto | null;
  total: number;
  items: ReferralListItemDto[];
  limit: number;
  offset: number;
};

type LoadErrorKey =
  | "referrals_error_network"
  | "referrals_error_unavailable"
  | "referrals_error_unknown";

type AssignmentErrorKey =
  | "referrals_referrer_error_network"
  | "referrals_referrer_error_not_found"
  | "referrals_referrer_error_conflict"
  | "referrals_referrer_error_unavailable"
  | "referrals_referrer_error_unknown";

const PREVIEW_DATA: ReferralData = {
  referralUrl: "https://t.me/meow_meow_vpn_bot?start=ref_preview",
  referrer: null,
  total: 3,
  limit: PAGE_SIZE,
  offset: 0,
  items: [
    {
      telegram_id: 100000101,
      display_name: "Анна",
      level: 1,
      created_at: "2026-07-21T13:30:00Z",
    },
    {
      telegram_id: 100000102,
      display_name: "Михаил",
      level: 1,
      created_at: "2026-07-20T09:15:00Z",
    },
    {
      telegram_id: 100000103,
      display_name: "Пользователь ToBeVPN",
      level: 2,
      created_at: "2026-07-18T18:45:00Z",
    },
  ],
};

class ReferralResponseError extends Error {}
class ReferrerResponseError extends Error {}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function safeInteger(value: unknown, fallback: number, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.trunc(value));
}

function normalizeReferralUser(value: unknown): ReferralUserDto | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as ReferralUserDto;
  const telegramId =
    typeof raw.telegram_id === "number" && Number.isSafeInteger(raw.telegram_id)
      ? raw.telegram_id
      : null;
  const displayName = safeText(raw.display_name, 200);
  if (telegramId === null && displayName === null) return null;
  return {
    telegram_id: telegramId,
    display_name: displayName,
  };
}

function normalizeReferralItem(value: unknown): ReferralListItemDto | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as ReferralListItemDto;
  const telegramId =
    typeof raw.telegram_id === "number" && Number.isSafeInteger(raw.telegram_id)
      ? raw.telegram_id
      : null;
  return {
    telegram_id: telegramId,
    display_name: safeText(raw.display_name, 200),
    level: safeInteger(raw.level, 1, 1),
    created_at: safeText(raw.created_at, 128),
  };
}

function normalizeReferralPage(raw: ReferralsDto): ReferralData {
  const rawItems = Array.isArray(raw.referrals)
    ? raw.referrals
    : Array.isArray(raw.referals)
      ? raw.referals
      : [];
  const items = rawItems
    .map(normalizeReferralItem)
    .filter((item): item is ReferralListItemDto => item !== null);
  const reportedTotal = safeInteger(raw.total, items.length);

  return {
    referralUrl: safeText(raw.referral_url, 2048) ?? "",
    referrer: normalizeReferralUser(raw.referrer),
    total: Math.max(reportedTotal, items.length),
    items,
    limit: safeInteger(raw.limit, PAGE_SIZE, 1),
    offset: safeInteger(raw.offset, 0),
  };
}

function referralItemKey(item: ReferralListItemDto): string {
  return [
    item.telegram_id ?? "",
    item.created_at ?? "",
    item.display_name ?? "",
  ].join("\u0000");
}

function mergeReferralPages(current: ReferralData, next: ReferralData): ReferralData {
  const unique = new Map<string, ReferralListItemDto>();
  for (const item of [...current.items, ...next.items]) {
    unique.set(referralItemKey(item), item);
  }
  return {
    referralUrl: next.referralUrl || current.referralUrl,
    referrer: next.referrer ?? current.referrer,
    total: next.total,
    items: [...unique.values()],
    limit: next.limit,
    offset: next.offset,
  };
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /network|failed to fetch|timed?\s*out|connection|dns|offline/i.test(message);
}

function toLoadError(error: unknown): LoadErrorKey {
  if (isNetworkFailure(error)) return "referrals_error_network";
  if (
    error instanceof ReferralResponseError ||
    (error instanceof ApiHttpError && [401, 403, 404].includes(error.status))
  ) {
    return "referrals_error_unavailable";
  }
  return "referrals_error_unknown";
}

function toAssignmentError(error: unknown): AssignmentErrorKey {
  if (isNetworkFailure(error)) return "referrals_referrer_error_network";
  if (error instanceof ApiHttpError) {
    if (error.status === 404) return "referrals_referrer_error_not_found";
    if (error.status === 409) return "referrals_referrer_error_conflict";
    if (error.status === 401 || error.status === 403) {
      return "referrals_referrer_error_unavailable";
    }
  }
  if (error instanceof ReferrerResponseError) {
    return "referrals_referrer_error_unknown";
  }
  return "referrals_referrer_error_unknown";
}

function parseReferrerId(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invitedCountText(total: number): string {
  if (getSavedLang() !== "ru") {
    return tf(
      total === 1
        ? "referrals_invited_count_one"
        : "referrals_invited_count_other",
      total,
    );
  }

  const mod10 = total % 10;
  const mod100 = total % 100;
  const key: StringKey =
    mod10 === 1 && mod100 !== 11
      ? "referrals_invited_count_one"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "referrals_invited_count_few"
        : "referrals_invited_count_many";
  return tf(key, total);
}

function formatReferralDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(getSavedLang() === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export default function ReferralsScreen({
  onBack,
  browserPreview = false,
}: {
  onBack: () => void;
  browserPreview?: boolean;
}) {
  const session = useSession();
  const previewParams = browserPreview
    ? new URLSearchParams(window.location.search)
    : null;
  const previewData =
    previewParams?.get("empty") === "1"
      ? { ...PREVIEW_DATA, total: 0, items: [] }
      : PREVIEW_DATA;
  const [data, setData] = useState<ReferralData | null>(
    browserPreview ? previewData : null,
  );
  const dataRef = useRef<ReferralData | null>(data);
  const requestSequenceRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const assignmentInFlightRef = useRef(false);
  const [isInitialLoading, setInitialLoading] = useState(
    !browserPreview && session.isLinked,
  );
  const [isRefreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [isAssigningReferrer, setAssigningReferrer] = useState(false);
  const [loadError, setLoadError] = useState<LoadErrorKey | null>(null);
  const [assignmentError, setAssignmentError] =
    useState<AssignmentErrorKey | null>(null);
  const [referrerInput, setReferrerInput] = useState("");
  const [pendingReferrerId, setPendingReferrerId] = useState<number | null>(
    previewParams?.get("confirm") === "1" ? 123456789 : null,
  );
  const [listOpen, setListOpen] = useState(
    previewParams?.get("sheet") === "1",
  );
  const { notice: copyNotice, copyWithNotification } = useCopyNotification();
  const closeList = useCallback(() => setListOpen(false), []);

  const commitData = useCallback((next: ReferralData | null) => {
    dataRef.current = next;
    setData(next);
  }, []);

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (requestInFlightRef.current) return;
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
        if (browserPreview) {
          if (refreshStartedAt !== null) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, MIN_REFRESH_FEEDBACK_MS),
            );
          }
          if (requestId === requestSequenceRef.current) {
            commitData(previewData);
          }
          return;
        }

        const offset = reset ? 0 : existing?.items.length ?? 0;
        const response = await getReferrals(PAGE_SIZE, offset);
        if (!response.success || !response.data) {
          throw new ReferralResponseError();
        }
        const page = normalizeReferralPage(response.data);

        if (refreshStartedAt !== null) {
          const remaining =
            MIN_REFRESH_FEEDBACK_MS - (performance.now() - refreshStartedAt);
          if (remaining > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, remaining));
          }
        }

        if (requestId !== requestSequenceRef.current) return;
        commitData(reset || !existing ? page : mergeReferralPages(existing, page));
      } catch (error) {
        if (requestId !== requestSequenceRef.current) return;
        console.warn("[referrals] request failed", error);
        setLoadError(toLoadError(error));
      } finally {
        if (requestId === requestSequenceRef.current) {
          requestInFlightRef.current = false;
          setInitialLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [browserPreview, commitData, previewData],
  );

  useEffect(() => {
    if (browserPreview) {
      setInitialLoading(false);
      return;
    }
    requestSequenceRef.current += 1;
    requestInFlightRef.current = false;
    commitData(null);
    setLoadError(null);
    setAssignmentError(null);
    setReferrerInput("");
    setPendingReferrerId(null);
    setListOpen(false);
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
  }, [
    browserPreview,
    commitData,
    loadPage,
    session.isLinked,
    session.shortUuid,
    session.telegramId,
  ]);

  const requestAssignReferrer = async (referrerId: number) => {
    if (
      assignmentInFlightRef.current ||
      dataRef.current?.referrer ||
      !session.isLinked
    ) {
      return;
    }

    assignmentInFlightRef.current = true;
    setAssigningReferrer(true);
    setAssignmentError(null);
    try {
      if (browserPreview) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      } else {
        const response = await setReferrer({ referrer_id: referrerId });
        if (!response.success) throw new ReferrerResponseError();
      }

      const current = dataRef.current;
      if (current) {
        commitData({
          ...current,
          referrer: {
            telegram_id: referrerId,
            display_name: null,
          },
        });
      }
      setReferrerInput("");
      setAssigningReferrer(false);
      assignmentInFlightRef.current = false;
      if (!browserPreview) void loadPage(true);
    } catch (error) {
      console.warn("[referrals] referrer assignment failed", error);
      setAssignmentError(toAssignmentError(error));
      setAssigningReferrer(false);
      assignmentInFlightRef.current = false;
    }
  };

  const referralUrl = data?.referralUrl ?? "";
  const parsedReferrerId = parseReferrerId(referrerInput);
  const localReferrerError =
    referrerInput.length > 0 && parsedReferrerId === null;

  const handleReferrerSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (parsedReferrerId !== null && !isAssigningReferrer) {
      setPendingReferrerId(parsedReferrerId);
    }
  };

  const handleCopy = () => {
    if (referralUrl) {
      void copyWithNotification(
        referralUrl,
        t("referrals_link_copied"),
      );
    }
  };

  const handleShare = async () => {
    if (!referralUrl) return;
    const shareUrl = new URL("https://t.me/share/url");
    shareUrl.searchParams.set("url", referralUrl);
    shareUrl.searchParams.set("text", t("referrals_share_message"));
    if (browserPreview) {
      window.open(shareUrl.toString(), "_blank", "noopener,noreferrer");
      return;
    }
    await openUrl(shareUrl.toString()).catch(() => {});
  };

  return (
    <div className="referrals-root">
      <header className="referrals-topbar">
        <button
          type="button"
          className="referrals-topbar__button"
          onClick={onBack}
          aria-label={t("back")}
          title={t("back")}
        >
          <MaterialIcon name="arrowBack" size={23} />
        </button>
        <h1 className="referrals-topbar__title">{t("referrals_title")}</h1>
        <TopbarRefreshButton
          label={t("refresh")}
          loading={isInitialLoading || isRefreshing}
          onClick={() => void loadPage(true)}
          disabled={
            !session.isLinked ||
            isInitialLoading ||
            isRefreshing ||
            isLoadingMore ||
            isAssigningReferrer
          }
        />
      </header>

      <main className="referrals-content">
        {!session.isLinked ? (
          <ReferralCenteredState
            title={t("referrals_auth_title")}
            description={t("referrals_auth_description")}
          />
        ) : isInitialLoading && data === null ? (
          <div className="referrals-loading" aria-label={t("referrals_loading")}>
            <Spinner size={30} thickness={3} className="spinner--accent" />
          </div>
        ) : data === null ? (
          <ReferralCenteredState
            title={t("referrals_error_title")}
            description={t(loadError ?? "referrals_error_unknown")}
            icon="cloudOff"
            action={
              <button
                type="button"
                className="referrals-primary-button referrals-centered__button"
                onClick={() => void loadPage(true)}
              >
                {t("referrals_retry")}
              </button>
            }
          />
        ) : (
          <>
            <section className="referrals-hero">
              <div className="referrals-hero__heading">
                <span className="referrals-icon referrals-icon--gift" aria-hidden="true">
                  <MaterialIcon name="cardGiftcard" size={27} />
                </span>
                <div>
                  <h2>{t("referrals_hero_title")}</h2>
                  <p>{t("referrals_hero_description")}</p>
                </div>
              </div>

              <div className="referrals-link-card">
                <div className="referrals-link-card__label">
                  <MaterialIcon name="link" size={19} />
                  <span>{t("referrals_your_link")}</span>
                </div>
                <div className="referrals-link-card__value">
                  {referralUrl || t("referrals_link_unavailable")}
                </div>
              </div>

              <div className="referrals-hero__actions">
                <button
                  type="button"
                  className="referrals-secondary-button"
                  onClick={handleCopy}
                  disabled={!referralUrl}
                >
                  <MaterialIcon name="contentCopy" size={19} />
                  {t("referrals_copy")}
                </button>
                <button
                  type="button"
                  className="referrals-primary-button"
                  onClick={() => void handleShare()}
                  disabled={!referralUrl}
                >
                  <MaterialIcon name="share" size={19} />
                  {t("referrals_share")}
                </button>
              </div>
            </section>

            {data.referrer === null ? (
              <form className="referrals-card" onSubmit={handleReferrerSubmit}>
                <div className="referrals-card__heading">
                  <span className="referrals-icon referrals-icon--green" aria-hidden="true">
                    <MaterialIcon name="personAdd" size={24} />
                  </span>
                  <div>
                    <h2>{t("referrals_referrer_input_title")}</h2>
                    <p>{t("referrals_referrer_input_description")}</p>
                  </div>
                </div>

                <label className="referrals-field">
                  <span className="referrals-field__label">
                    {t("referrals_referrer_id_label")}
                  </span>
                  <span className="referrals-field__control">
                    <MaterialIcon name="person" size={19} />
                    <input
                      value={referrerInput}
                      onChange={(event) => {
                        setReferrerInput(
                          event.currentTarget.value
                            .replace(/\D/g, "")
                            .slice(0, MAX_TELEGRAM_ID_DIGITS),
                        );
                        setAssignmentError(null);
                      }}
                      inputMode="numeric"
                      autoComplete="off"
                      disabled={isAssigningReferrer}
                      aria-invalid={localReferrerError || assignmentError !== null}
                    />
                  </span>
                </label>
                {(localReferrerError || assignmentError) && (
                  <div className="referrals-field__error" role="alert">
                    {t(
                      localReferrerError
                        ? "referrals_referrer_id_invalid"
                        : assignmentError!,
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  className="referrals-primary-button referrals-card__submit"
                  disabled={parsedReferrerId === null || isAssigningReferrer}
                >
                  {isAssigningReferrer && <Spinner size={18} thickness={2} />}
                  {t(
                    isAssigningReferrer
                      ? "referrals_referrer_assigning"
                      : "referrals_referrer_assign",
                  )}
                </button>
              </form>
            ) : (
              <section className="referrals-card referrals-referrer-card">
                <span className="referrals-icon referrals-icon--green" aria-hidden="true">
                  <MaterialIcon name="person" size={24} />
                </span>
                <div>
                  <p>{t("referrals_referred_by")}</p>
                  <h2>
                    {safeText(data.referrer.display_name, 200) ??
                      (data.referrer.telegram_id
                        ? tf(
                            "referrals_referrer_id_value",
                            data.referrer.telegram_id,
                          )
                        : t("referrals_unknown_user"))}
                  </h2>
                </div>
              </section>
            )}

            {isRefreshing ? (
              <ReferralSummarySkeleton />
            ) : (
              <section className="referrals-card referrals-summary">
                <div className="referrals-summary__row">
                  <span className="referrals-icon referrals-icon--blue" aria-hidden="true">
                    <MaterialIcon name="groups" size={26} />
                  </span>
                  <div>
                    <strong>{data.total}</strong>
                    <span>{invitedCountText(data.total)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="referrals-outline-button"
                  onClick={() => setListOpen(true)}
                >
                  {t("referrals_open_list")}
                </button>
              </section>
            )}

            {loadError && (
              <ReferralInlineError
                error={loadError}
                onRetry={() => void loadPage(true)}
              />
            )}
          </>
        )}
      </main>

      {listOpen && data && (
        <InvitedFriendsSheet
          items={data.items}
          total={data.total}
          error={loadError}
          isRefreshing={isRefreshing}
          isLoadingMore={isLoadingMore}
          onRetry={() => void loadPage(true)}
          onLoadMore={() => void loadPage(false)}
          onDismiss={closeList}
        />
      )}

      {pendingReferrerId !== null && (
        <ReferrerConfirmationDialog
          referrerId={pendingReferrerId}
          onDismiss={() => setPendingReferrerId(null)}
          onConfirm={() => {
            const id = pendingReferrerId;
            setPendingReferrerId(null);
            void requestAssignReferrer(id);
          }}
        />
      )}

      <CopyNotification notice={copyNotice} />
    </div>
  );
}

function ReferralCenteredState({
  title,
  description,
  action,
  icon = "groupAdd",
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: "groupAdd" | "cloudOff";
}) {
  return (
    <div className="referrals-centered">
      <span className="referrals-icon referrals-icon--blue" aria-hidden="true">
        <MaterialIcon
          name={icon}
          size={icon === "cloudOff" ? 48 : 38}
        />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function ReferralSummarySkeleton() {
  return (
    <section className="referrals-card referrals-summary referrals-skeleton" aria-hidden="true">
      <div className="referrals-summary__row">
        <span className="referrals-skeleton__circle" />
        <div>
          <span className="referrals-skeleton__line referrals-skeleton__line--short" />
          <span className="referrals-skeleton__line" />
        </div>
      </div>
      <span className="referrals-skeleton__button" />
    </section>
  );
}

function ReferralInlineError({
  error,
  onRetry,
}: {
  error: LoadErrorKey;
  onRetry: () => void;
}) {
  return (
    <div className="referrals-inline-error" role="alert">
      <span>{t(error)}</span>
      <button type="button" onClick={onRetry}>
        {t("referrals_retry")}
      </button>
    </div>
  );
}

function ReferralListRow({ item }: { item: ReferralListItemDto }) {
  const date = formatReferralDate(item.created_at);
  return (
    <article className="referrals-list-row">
      <span className="referrals-list-row__avatar" aria-hidden="true">
        <MaterialIcon name="person" size={22} />
      </span>
      <div className="referrals-list-row__info">
        <strong>
          {safeText(item.display_name, 200) ?? t("referrals_unknown_user")}
        </strong>
        {date && <span>{tf("referrals_joined", date)}</span>}
      </div>
      <span className="referrals-list-row__level">
        {tf("referrals_level", safeInteger(item.level, 1, 1))}
      </span>
    </article>
  );
}

function ReferralListSkeleton({ index }: { index: number }) {
  return (
    <div
      className="referrals-list-row referrals-list-row--skeleton referrals-skeleton"
      aria-hidden="true"
      key={index}
    >
      <span className="referrals-skeleton__circle referrals-skeleton__circle--small" />
      <div className="referrals-list-row__info">
        <span className="referrals-skeleton__line" />
        <span className="referrals-skeleton__line referrals-skeleton__line--tiny" />
      </div>
      <span className="referrals-skeleton__pill" />
    </div>
  );
}

function InvitedFriendsSheet({
  items,
  total,
  error,
  isRefreshing,
  isLoadingMore,
  onRetry,
  onLoadMore,
  onDismiss,
}: {
  items: ReferralListItemDto[];
  total: number;
  error: LoadErrorKey | null;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onDismiss: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onDismiss, SHEET_EXIT_MS);
  }, [onDismiss]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, [requestClose]);

  const target = document.getElementById("overlay-root") ?? document.body;
  return createPortal(
    <div
      className={`referrals-sheet-overlay ${
        closing ? "referrals-sheet-overlay--closing" : ""
      }`}
      onClick={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        className={`referrals-sheet ${closing ? "referrals-sheet--closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="referrals-sheet-title"
      >
        <div className="referrals-sheet__handle" aria-hidden="true" />
        <div className="referrals-sheet__header">
          <h2 id="referrals-sheet-title">{t("referrals_invited_title")}</h2>
          <p>{invitedCountText(total)}</p>
        </div>
        <div className="referrals-sheet__body">
          {error && <ReferralInlineError error={error} onRetry={onRetry} />}

          {isRefreshing ? (
            <div className="referrals-list">
              {[0, 1, 2].map((index) => (
                <ReferralListSkeleton index={index} key={index} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="referrals-empty">
              <span className="referrals-empty__icon" aria-hidden="true">
                <MaterialIcon name="groupAdd" size={40} />
              </span>
              <h3>{t("referrals_empty_title")}</h3>
              <p>{t("referrals_empty_description")}</p>
            </div>
          ) : (
            <div className="referrals-list">
              {items.map((item, index) => (
                <ReferralListRow
                  item={item}
                  key={`${referralItemKey(item)}:${index}`}
                />
              ))}
            </div>
          )}

          {!isRefreshing && items.length < total && (
            <button
              type="button"
              className="referrals-outline-button referrals-sheet__more"
              onClick={onLoadMore}
              disabled={isLoadingMore}
            >
              {isLoadingMore && <Spinner size={17} thickness={2} />}
              {t("referrals_load_more")}
            </button>
          )}
        </div>
      </div>
    </div>,
    target,
  );
}

function ReferrerConfirmationDialog({
  referrerId,
  onConfirm,
  onDismiss,
}: {
  referrerId: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const target = document.getElementById("overlay-root") ?? document.body;
  return createPortal(
    <div
      className="referrals-confirm-overlay"
      onClick={(event) => event.target === event.currentTarget && onDismiss()}
    >
      <div
        ref={dialogRef}
        className="referrals-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="referrals-confirm-title"
        aria-describedby="referrals-confirm-description"
      >
        <span className="referrals-icon referrals-icon--green" aria-hidden="true">
          <MaterialIcon name="personAdd" size={24} />
        </span>
        <h2 id="referrals-confirm-title">
          {t("referrals_referrer_confirm_title")}
        </h2>
        <p id="referrals-confirm-description">
          {t("referrals_referrer_confirm_description")}
        </p>
        <strong>{tf("referrals_referrer_id_value", referrerId)}</strong>
        <div className="referrals-confirm__actions">
          <button
            type="button"
            className="referrals-secondary-button"
            onClick={onDismiss}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="referrals-primary-button"
            onClick={onConfirm}
          >
            {t("referrals_referrer_confirm")}
          </button>
        </div>
      </div>
    </div>,
    target,
  );
}
