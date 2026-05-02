// Shared DTO types — mirror the backend backend (snake_case) and panel proxy responses.
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
  device_id: string;
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

export interface LinkedDeviceDto {
  device_id: string;
  device_name?: string | null;
  device_type?: string | null;
  platform?: string | null;
  linked_at?: number | null;
  last_seen_at?: number | null;
}

export interface LinkedDevicesDto {
  max_devices: number;
  devices: LinkedDeviceDto[];
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
  status: string;
  traffic_limit_bytes: number;
  traffic_limit_strategy: string;
  expire_at: string | null;
  telegram_id: number | null;
  vless_uuid: string;
  subscription_url: string;
  active_internal_squads: PanelSquadRefDto[];
  user_traffic: PanelUserTrafficDto | null;
  hwid_device_limit?: number | null;
  email?: string | null;
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

// --- Subscription info ---

export interface PanelSubUserDto {
  short_uuid: string;
  days_left: number;
  traffic_used: string;
  traffic_limit: string;
  traffic_used_bytes: string;
  traffic_limit_bytes: string;
  lifetime_traffic_used_bytes: string;
  username: string;
  expires_at: string | null;
  is_active: boolean;
  user_status: string;
  traffic_limit_strategy: string;
}

export interface PanelSubInfoDto {
  is_found: boolean;
  user: PanelSubUserDto | null;
  links: string[] | null;
  subscription_url: string | null;
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
