// Shared DTO types — mirror the backend (snake_case) and panel proxy responses.
// Field shapes match Android phone/TV clients exactly.

export interface ApiResponse<T> {
  success: boolean;
  message?: string | null;
  data?: T | null;
}

// Generic panel proxy wrapper
export interface PanelResponse<T> {
  response: T;
}

// --- Device session bootstrap / refresh ---

export interface BootstrapRequestDto {
  device_id: string;
  platform: string;
  integrity_token?: string | null;
}

export interface RefreshRequestDto {
  refresh_token: string;
}

export interface SessionTokensDto {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  device_id?: string | null;
  telegram_id?: number | null;
  panel_user_uuid?: string | null;
  short_uuid?: string | null;
  is_linked: boolean;
}

// --- Deep-link authentication ---

export interface AuthRequestDto {
  device_id?: string;
  panel_user_uuid?: string | null;
}

export interface AuthRequestResponseDto {
  auth_token: string;
}

export interface AuthStatusDto {
  status: "pending" | "completed" | string;
  telegram_id?: number | null;
  short_uuid?: string | null;
}

// --- Devices ---

export interface DeviceRegisterRequestDto {
  device_name: string;
  device_type: string;
  platform: string;
}

export interface DeviceUnlinkRequestDto {
  device_id: string;
}

export interface DeviceUnlinkResponseDto extends CurrentPlanDto {
  remaining_devices?: number | null;
  subscription_url?: string | null;
  bot_subscription_updated?: boolean | null;
  bot_subscription_changed?: boolean | null;
  linked_devices_updated?: number | null;
}

export interface LinkedDeviceDto {
  device_id: string;
  hwid?: string | null;
  device_name?: string | null;
  device_type?: string | null;
  platform?: string | null;
  device_model?: string | null;
  user_agent?: string | null;
  linked_at?: number | null;
  last_seen_at?: number | null;
}

export interface LinkedDevicesDto {
  current_count?: number | null;
  max_devices: number;
  devices: LinkedDeviceDto[];
}

// --- Referrals ---

export interface ReferralUserDto {
  telegram_id?: number | null;
  display_name?: string | null;
}

export interface ReferralListItemDto {
  telegram_id?: number | null;
  display_name?: string | null;
  level?: number | null;
  created_at?: string | null;
}

export interface ReferralsDto {
  referral_code?: string | null;
  referral_url?: string | null;
  referrer?: ReferralUserDto | null;
  total?: number | null;
  // RemnaShop v0.9.4 shipped the typo `referals`; accept both spellings so
  // desktop remains compatible when the server corrects the contract.
  referrals?: ReferralListItemDto[] | null;
  referals?: ReferralListItemDto[] | null;
  limit?: number | null;
  offset?: number | null;
}

export interface SetReferrerRequestDto {
  referrer_id: number;
}

export interface SetReferrerResponseDto {
  referrer_id?: number | null;
  created?: boolean | null;
}

// --- Promocodes ---

export interface PromocodeActivateRequestDto {
  code: string;
  request_id: string;
}

export interface PromocodePlanSnapshotDto {
  name?: string | null;
  duration?: number | null;
}

export interface PromocodeActivationResultDto {
  request_id?: string | null;
  code?: string | null;
  reward_type?: string | null;
  reward?: number | null;
  plan_snapshot?: PromocodePlanSnapshotDto | null;
}

export interface PromocodeHistoryItemDto {
  activation_id?: number | null;
  promocode_id?: number | null;
  code?: string | null;
  reward_type?: string | null;
  reward?: number | null;
  plan_snapshot?: PromocodePlanSnapshotDto | null;
  activated_at?: string | null;
}

export interface PromocodeHistoryDto {
  telegram_id: number;
  total: number;
  limit: number;
  offset: number;
  promocodes?: PromocodeHistoryItemDto[] | null;
}

// --- Email ---

export interface SaveEmailRequestDto {
  panel_user_uuid?: string | null;
  email: string;
}

// --- TV pairing ---

export interface TvPairCreateRequestDto {
  device_id?: string;
}

export interface TvPairCreateResponseDto {
  code: string;
  expires_in: number;
}

export interface TvPairStatusDto {
  status: "pending" | "completed" | "expired" | string;
  telegram_id?: number | null;
  short_uuid?: string | null;
  panel_user_uuid?: string | null;
}

// --- Panel users ---

export interface PanelSquadRefDto {
  uuid: string;
  name: string;
}

export interface PanelUserTrafficDto {
  used_traffic_bytes: number;
  lifetime_used_traffic_bytes: number;
  online_at: string | null;
  last_connected_node_uuid: string | null;
}

export interface PanelUserDto {
  uuid: string;
  short_uuid: string;
  username: string;
  status?: string | null;
  traffic_limit_bytes?: number | null;
  traffic_limit_strategy?: string | null;
  expire_at: string | null;
  telegram_id: number | null;
  vless_uuid: string;
  subscription_url: string;
  active_internal_squads?: PanelSquadRefDto[] | null;
  user_traffic: PanelUserTrafficDto | null;
  hwid_device_limit?: number | null;
  email?: string | null;
  // The bot stores the Telegram profile here as "name: <full name>\n
  // username: <handle>"; parsed for the account-card display name.
  description?: string | null;
}

// --- Panel nodes ---

export interface PanelNodeDto {
  uuid: string;
  name: string;
  address: string;
  port: number;
  is_connected: boolean;
  is_disabled: boolean;
  country_code: string;
  view_position: number;
}

export interface CurrentPlanSnapshotDto {
  id?: number | null;
  name?: string | null;
  type?: string | null;
  traffic_limit?: number | null;
  traffic_limit_bytes?: number | null;
  device_limit?: number | null;
  duration?: number | null;
  duration_days?: number | null;
  tag?: string | null;
  is_trial?: boolean | null;
  traffic_limit_strategy?: string | null;
}

export interface CurrentPlanSubscriptionDto {
  expire_at?: string | null;
  expires_at?: string | null;
  expire_at_ts?: number | null;
  status?: string | null;
  stored_status?: string | null;
  is_active?: boolean | null;
  is_expired?: boolean | null;
  is_unlimited?: boolean | null;
  is_trial?: boolean | null;
  traffic_limit?: number | null;
  traffic_limit_bytes?: number | null;
  traffic_limit_strategy?: string | null;
  device_limit?: number | null;
  created_at?: string | null;
  created_at_ts?: number | null;
  url?: string | null;
}

export interface CurrentPlanDto {
  is_admin?: boolean | null;
  renewal_url?: string | null;
  current_plan?: CurrentPlanSnapshotDto | null;
  plan_snapshot?: CurrentPlanSnapshotDto | null;
  subscription?: CurrentPlanSubscriptionDto | null;
  plan_name?: string | null;
  name?: string | null;
  status?: string | null;
  expire_at?: string | null;
  expires_at?: string | null;
}

// --- Purchase plans ---

export interface PurchasePriceDto {
  currency: "USD" | "RUB" | "XTR" | string;
  amount: string;
}

export interface PurchasePaymentMethodDto {
  gateway_type: "TELEGRAM_STARS" | "CRYPTOMUS" | string;
  currency: string;
  original_amount: string;
  final_amount: string;
  discount_percent: number;
}

export interface PurchaseDurationDto {
  id: number;
  days: number;
  order_index: number;
  bot_start_param?: string | null;
  bot_payment_url?: string | null;
  prices: PurchasePriceDto[];
  payment_methods: PurchasePaymentMethodDto[];
}

export interface PurchasePlanDto {
  id: number;
  public_code: string;
  name: string;
  description?: string | null;
  type: string;
  availability: string;
  purchase_type: "NEW" | "RENEW" | "CHANGE" | string;
  traffic_limit: number;
  traffic_limit_strategy?: string | null;
  device_limit: number;
  tag?: string | null;
  order_index: number;
  internal_squad_uuids: string[];
  external_squad_uuid?: string | null;
  durations: PurchaseDurationDto[];
}

export interface PurchasePlansDto {
  telegram_id: number;
  effective_discount_percent: number;
  plans: PurchasePlanDto[];
}
