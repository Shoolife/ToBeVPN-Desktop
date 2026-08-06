import {
  ApiHttpError,
  activatePromocode as apiActivatePromocode,
  ensureDeviceSession,
  getAppliedPromocodes,
} from "../api/client";
import type {
  PromocodeActivationResultDto,
  PromocodeHistoryDto,
  PromocodeHistoryItemDto,
  PromocodePlanSnapshotDto,
} from "../api/types";
import { getSession } from "./store";

const PENDING_STORAGE_KEY = "tobevpn_pending_promocode_activations_v1";
const PENDING_STORAGE_VERSION = 1;
const MAX_PENDING_ATTEMPTS = 50;
const MAX_PROMOCODE_LENGTH = 128;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PendingActivation {
  telegramId: number;
  code: string;
  requestId: string;
  createdAt: number;
}

interface PendingActivationRecord {
  version: number;
  entries: PendingActivation[];
}

let pendingActivationMemory: PendingActivation[] = [];

export class PromocodeResponseError extends Error {
  constructor(message = "Promocode server returned an invalid response") {
    super(message);
    this.name = "PromocodeResponseError";
  }
}

export class PromocodeAuthenticationError extends Error {
  constructor() {
    super("Promocode activation requires an authenticated Telegram account");
    this.name = "PromocodeAuthenticationError";
  }
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function normalizePlanSnapshot(value: unknown): PromocodePlanSnapshotDto | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const name = safeText(raw.name, 128);
  const duration = safeInteger(raw.duration, 0, 36_500);
  if (name === null && duration === null) return null;
  return { name, duration };
}

function normalizeHistoryItem(value: unknown): PromocodeHistoryItemDto | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const activationId = safeInteger(raw.activation_id, 1, Number.MAX_SAFE_INTEGER);
  const promocodeId = safeInteger(raw.promocode_id, 1, Number.MAX_SAFE_INTEGER);
  const code = safeText(raw.code, MAX_PROMOCODE_LENGTH);
  const rewardType = safeText(raw.reward_type, 64)?.toLocaleUpperCase("en-US") ?? null;
  const reward = safeInteger(raw.reward, 0, 1_000_000_000);
  const activatedAt = safeText(raw.activated_at, 128);
  const planSnapshot = normalizePlanSnapshot(raw.plan_snapshot);
  if (
    activationId === null &&
    promocodeId === null &&
    code === null &&
    rewardType === null &&
    activatedAt === null
  ) {
    return null;
  }
  return {
    activation_id: activationId,
    promocode_id: promocodeId,
    code,
    reward_type: rewardType,
    reward,
    plan_snapshot: planSnapshot,
    activated_at: activatedAt,
  };
}

export function normalizePromocodeHistory(
  value: unknown,
  expectedTelegramId: number,
): PromocodeHistoryDto {
  if (!value || typeof value !== "object") throw new PromocodeResponseError();
  const raw = value as Record<string, unknown>;
  const telegramId = safeInteger(raw.telegram_id, 1, Number.MAX_SAFE_INTEGER);
  if (telegramId === null || telegramId !== expectedTelegramId) {
    throw new PromocodeResponseError();
  }
  const items = Array.isArray(raw.promocodes)
    ? raw.promocodes
        .slice(0, 100)
        .map(normalizeHistoryItem)
        .filter((item): item is PromocodeHistoryItemDto => item !== null)
    : [];
  const total = safeInteger(raw.total, 0, 1_000_000) ?? items.length;
  return {
    telegram_id: telegramId,
    total: Math.max(total, items.length),
    limit: safeInteger(raw.limit, 1, 100) ?? 20,
    offset: safeInteger(raw.offset, 0, 1_000_000) ?? 0,
    promocodes: items,
  };
}

function normalizeActivationResult(
  value: unknown,
  expectedRequestId: string,
  fallbackCode: string,
): PromocodeActivationResultDto {
  if (!value || typeof value !== "object") throw new PromocodeResponseError();
  const raw = value as Record<string, unknown>;
  const requestId = safeText(raw.request_id, 64);
  if (requestId !== null && requestId.toLocaleLowerCase("en-US") !== expectedRequestId) {
    throw new PromocodeResponseError();
  }
  return {
    request_id: requestId ?? expectedRequestId,
    code: safeText(raw.code, MAX_PROMOCODE_LENGTH) ?? fallbackCode,
    reward_type: safeText(raw.reward_type, 64)?.toLocaleUpperCase("en-US") ?? null,
    reward: safeInteger(raw.reward, 0, 1_000_000_000),
    plan_snapshot: normalizePlanSnapshot(raw.plan_snapshot),
  };
}

export function normalizePromocodeCode(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .toLocaleUpperCase("en-US")
    .slice(0, MAX_PROMOCODE_LENGTH);
}

function isPendingActivation(value: unknown): value is PendingActivation {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    safeInteger(raw.telegramId, 1, Number.MAX_SAFE_INTEGER) !== null &&
    normalizePromocodeCode(String(raw.code ?? "")) === raw.code &&
    UUID_V4_RE.test(String(raw.requestId ?? "")) &&
    safeInteger(raw.createdAt, 1, Number.MAX_SAFE_INTEGER) !== null
  );
}

function readPendingActivations(): PendingActivation[] {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return pendingActivationMemory;
    const parsed = JSON.parse(raw) as Partial<PendingActivationRecord>;
    if (parsed.version !== PENDING_STORAGE_VERSION || !Array.isArray(parsed.entries)) {
      localStorage.removeItem(PENDING_STORAGE_KEY);
      pendingActivationMemory = [];
      return pendingActivationMemory;
    }
    pendingActivationMemory = parsed.entries
      .filter(isPendingActivation)
      .slice(-MAX_PENDING_ATTEMPTS);
    return pendingActivationMemory;
  } catch {
    return pendingActivationMemory;
  }
}

function writePendingActivations(entries: PendingActivation[]): void {
  pendingActivationMemory = entries.slice(-MAX_PENDING_ATTEMPTS);
  try {
    if (pendingActivationMemory.length === 0) {
      localStorage.removeItem(PENDING_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      PENDING_STORAGE_KEY,
      JSON.stringify({
        version: PENDING_STORAGE_VERSION,
        entries: pendingActivationMemory,
      } satisfies PendingActivationRecord),
    );
  } catch {
    // The in-memory copy still keeps retries idempotent for this app session.
  }
}

function createUuidV4(): string {
  const cryptoApi = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getOrCreatePendingActivation(
  telegramId: number,
  code: string,
): PendingActivation {
  const entries = readPendingActivations();
  const existing = entries.find(
    (entry) => entry.telegramId === telegramId && entry.code === code,
  );
  if (existing) return existing;
  const created: PendingActivation = {
    telegramId,
    code,
    requestId: createUuidV4(),
    createdAt: Date.now(),
  };
  writePendingActivations([...entries, created]);
  return created;
}

function clearPendingActivation(attempt: PendingActivation): void {
  writePendingActivations(
    readPendingActivations().filter(
      (entry) =>
        entry.telegramId !== attempt.telegramId ||
        entry.code !== attempt.code ||
        entry.requestId !== attempt.requestId,
    ),
  );
}

function shouldDiscardPendingAttempt(error: unknown): boolean {
  return error instanceof ApiHttpError &&
    error.status >= 400 &&
    error.status <= 499 &&
    error.status !== 408;
}

export async function fetchPromocodeHistory(
  limit: number,
  offset: number,
): Promise<PromocodeHistoryDto> {
  const session = getSession();
  if (!session.isLinked || session.telegramId === null) {
    throw new PromocodeAuthenticationError();
  }
  const expectedTelegramId = session.telegramId;
  const response = await getAppliedPromocodes(limit, offset);
  if (!response.success || !response.data) throw new PromocodeResponseError();
  return normalizePromocodeHistory(response.data, expectedTelegramId);
}

export async function applyPromocode(
  rawCode: string,
): Promise<PromocodeActivationResultDto> {
  const code = normalizePromocodeCode(rawCode);
  const session = getSession();
  if (!code || !session.isLinked || session.telegramId === null) {
    throw new PromocodeAuthenticationError();
  }
  const attempt = getOrCreatePendingActivation(session.telegramId, code);
  const request = { code, request_id: attempt.requestId };

  try {
    let response;
    try {
      response = await apiActivatePromocode(request);
    } catch (error) {
      if (!(error instanceof ApiHttpError) || ![401, 403].includes(error.status)) {
        throw error;
      }
      // POST requests are not retried automatically by the generic client.
      // Reuse the exact same request_id after session recovery so an
      // activation committed before the 401 response cannot be duplicated.
      await ensureDeviceSession();
      response = await apiActivatePromocode(request);
    }

    if (!response.success || !response.data) throw new PromocodeResponseError();
    const result = normalizeActivationResult(response.data, attempt.requestId, code);
    clearPendingActivation(attempt);
    return result;
  } catch (error) {
    if (shouldDiscardPendingAttempt(error)) clearPendingActivation(attempt);
    throw error;
  }
}
