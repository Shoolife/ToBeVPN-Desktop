export type Lang = "ru" | "en";

const STORAGE_KEY = "tobevpn_lang";

export function getSavedLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "en" || saved === "ru") return saved;
  // First launch — pick a sane default from the OS / browser locale so
  // the very first frame (Splash, Pairing) reads correctly. We only
  // ship Russian and English, so anything that doesn't look English
  // falls back to Russian.
  const sys =
    typeof navigator !== "undefined"
      ? (navigator.language || (navigator.languages && navigator.languages[0]) || "")
          .toLowerCase()
      : "";
  return sys.startsWith("en") ? "en" : "ru";
}

export function saveLang(lang: Lang) {
  localStorage.setItem(STORAGE_KEY, lang);
}

const strings = {
  ru: {
    // Brand
    app_partner: "× Meow VPN",

    // Splash
    splash_tagline: "твоё будущее приватно",

    // Onboarding
    onboarding_subtitle: "Пробный тариф для первого подключения",
    onboarding_feature_trial: "Пробный тариф: 3 ГБ трафика на 3 дня",
    onboarding_feature_device: "Пробный тариф: 1 устройство",
    onboarding_feature_auth: "Авторизуйтесь через Telegram, чтобы не потерять доступ",
    onboarding_feature_tools: "Серверы, статистика и тест скорости встроены",
    onboarding_continue: "Продолжить",

    // Pairing
    pairing_title: "Войти через телефон",
    pairing_subtitle: "Отсканируйте QR телефоном и подтвердите вход в Telegram",
    pairing_waiting: "Ожидание подтверждения в Telegram…",
    pairing_open_telegram: "Открыть Telegram на этом ПК",
    pairing_opening_telegram: "Открываем Telegram…",
    pairing_open_failed: "Не удалось открыть Telegram",
    not_authorized: "Не авторизован",

    // Connection states
    state_disconnected: "Отключено",
    state_connecting: "Подключение…",
    state_disconnecting: "Отключение…",
    state_connected: "Подключено",

    // Home
    server_choose: "Выберите сервер",
    current_session: "Текущая сессия",
    downloaded: "Загружено",
    session_time: "Время",
    traffic: "Трафик",
    subscription: "Подписка",
    free_tier_hint: "Бесплатный пробный период",
    trial_access_banner: "ВРЕМЕННЫЙ ПРОБНЫЙ ДОСТУП",
    trial_access_title: "Временный доступ",
    trial_access_description: "Пробный доступ выдаётся один раз и быстро заканчивается. Оформите тариф, чтобы сохранить доступ к серверам и не потерять подключение после окончания пробного периода.",
    trial_access_open_plans: "К тарифам",

    // Servers
    server_select: "Выберите сервер",
    server_unavailable: "Недоступен",
    server_offline: "offline",
    servers_empty: "Нет доступных серверов",
    servers_load_error: "Ошибка загрузки",
    plans_load_error: "Не удалось загрузить тарифы",
    refresh: "Обновить",
    country_NL: "Нидерланды",
    country_DE: "Германия",
    country_US: "США",
    country_GB: "Великобритания",
    country_FI: "Финляндия",
    country_SE: "Швеция",
    country_FR: "Франция",
    country_JP: "Япония",
    country_SG: "Сингапур",
    country_CA: "Канада",
    country_AU: "Австралия",
    country_TR: "Турция",

    // Settings
    settings: "Настройки",
    account: "Аккаунт",
    telegram_id: "Telegram ID",
    plan: "Тариф",
    plan_free: "Пробный",
    plan_standard: "Стандарт",
    plan_admin: "Админ",
    plan_expired: "Истёк",
    devices_title: "Устройства",
    devices_manage_hint: "Посмотрите и отключите устройства, привязанные к аккаунту.",
    devices_count: "устройств подключено",
    devices_scan_qr: "Сканировать QR",
    devices_refresh: "Обновить",
    devices_this_device: "Это устройство",
    devices_other_devices: "Другие устройства",
    devices_empty: "Других подключённых устройств пока нет.",
    devices_disconnect: "Отключить",
    devices_current_badge: "Текущее устройство",
    devices_type_phone: "Телефон",
    devices_type_tv: "TV",
    devices_type_desktop: "ПК",
    email_title: "Email",
    email_hint: "Email для получения актуальной ссылки на подписку",
    expires: "Действует до",
    renew_in_bot: "Продлите подписку в @meow_meow_vpn_bot",
    email_not_set: "Не указан",
    email_save: "Сохранить",
    email_placeholder: "Введите email",
    email_error: "Не удалось сохранить email",
    language: "Язык",
    language_english: "Английский",
    language_russian: "Русский",
    language_restart_title: "Требуется перезапуск",
    language_restart_message: "Для применения нового языка необходимо перезапустить приложение.",
    language_restart_button: "Перезапустить",
    cancel: "Отмена",
    about: "О приложении",
    version: "Версия",
    xray: "XRay",
    logout: "Выйти",

    // Stats
    stats_title: "Статистика",
    stats_total_used: "Использовано всего",
    stats_your_stats: "Ваша статистика",
    stats_metric_sessions: "Сессии",
    stats_metric_time: "Время",
    stats_metric_avg: "Среднее",
    stats_period_day: "День",
    stats_period_week: "Неделя",
    stats_period_month: "Месяц",
    stats_no_data: "Нет данных за этот период",
    stats_today_by_hour: "Сегодня по часам",
    stats_week_by_day: "Неделя по дням",
    stats_month_by_week: "Месяц по неделям",
    stats_sessions_short: "сессий",
    stats_week_short: "Нед.",
    back: "Назад",

    // Subscription sheet
    current_plan: "Текущий тариф",
    plan_limited_traffic: "Ограниченный трафик",
    plan_unlimited_access: "Безлимитный доступ",
    plan_active_until: "Активна до {0}",
    plan_until: "до {0}",
    plan_quota_month: "XXX ГБ / месяц",
    plan_renew_full: "Продлите подписку (XXX ГБ / месяц · до XX устройств)",
    unit_gb: "ГБ",
    per_month_short: "в месяц",
    devices_label: "устройств",
    plan_traffic_month_fmt: "{0} ГБ / месяц",
    plan_devices_fmt: "до {0} устройств",
    plan_devices_unknown: "до XX устройств",
    plan_unlimited_traffic: "Безлимитный трафик",
    available_plans: "Доступные тарифы",
    loading_data: "Загрузка…",
    plans_loading: "Загружаем тарифы…",
    payment_via_telegram: "Оплата через Telegram",
    buy_plan: "Купить «{0}» за {1}",
    plan_day: "1 день",
    plan_week: "7 дней",
    plan_month: "1 месяц",
    plan_3month: "3 месяца",
    plan_year: "1 год",
    subscription_qr_title: "Сканируйте для покупки",
    subscription_qr_hint: "Отсканируйте телефоном, чтобы открыть @meow_meow_vpn_bot и продолжить покупку.",
    subscription_sync_hint: "Тариф обновится автоматически после оплаты.",
    subscription_change_plan: "Выбрать другой тариф",
    close: "Закрыть",

    // Speed test
    speed_test_title: "Тест скорости",
    speed_test_subtitle: "Проверить скорость интернета",
    speed_press_start: "Нажмите «Начать»",
    speed_measuring_ping: "Измерение пинга…",
    speed_downloading: "Загрузка…",
    speed_done: "Тест завершён",
    speed_ping: "Пинг",
    speed_download: "Загрузка",
    speed_start_test: "Начать тест",
    speed_stop: "Остановить",
    speed_unit_ms: "мс",
    speed_unit_mbps: "Мбит/с",
    speed_via_vpn: "Через VPN",
    speed_direct: "Напрямую",
    speed_no_connection: "Нет соединения",
    speed_measure_failed: "Не удалось измерить скорость",

    // In-app updater (`{version}` placeholder is substituted by JS at runtime —
    // we don't use tf() because the indexed placeholder syntax doesn't read
    // well in update strings, so we keep simple string replace in the banner).
    update_banner_title: "Доступна v{version}",
    update_banner_download: "Скачать",
    update_banner_later: "Позже",
    update_banner_downloading_title: "Загружаем v{version}",
    update_banner_installing_privileged: "Скачиваем и устанавливаем подписанное обновление…",
    update_banner_cancel: "Отменить",
    update_banner_ready_title: "v{version} готова к установке",
    update_banner_ready_description: "Перезапустите приложение, чтобы применить обновление.",
    update_banner_install: "Установить",
    update_banner_failed_title: "Не удалось обновить",
    update_banner_retry: "Повторить",
    update_check_button: "Проверить",
    update_check_button_loading: "Проверка…",
    update_check_uptodate: "Версия {version}",
    update_available_short: "Версия {current} · доступна v{version}",
  },
  en: {
    // Brand
    app_partner: "× Meow VPN",

    // Splash
    splash_tagline: "your future is private",

    // Onboarding
    onboarding_subtitle: "Trial plan for your first connection",
    onboarding_feature_trial: "Trial plan: 3 GB of traffic for 3 days",
    onboarding_feature_device: "Trial plan: 1 device",
    onboarding_feature_auth: "Sign in via Telegram so you do not lose access",
    onboarding_feature_tools: "Servers, statistics, and speed test are built in",
    onboarding_continue: "Continue",

    // Pairing
    pairing_title: "Sign in via phone",
    pairing_subtitle: "Scan the QR code with your phone and confirm sign in in Telegram",
    pairing_waiting: "Waiting for Telegram confirmation…",
    pairing_open_telegram: "Open Telegram on this PC",
    pairing_opening_telegram: "Opening Telegram…",
    pairing_open_failed: "Could not open Telegram",
    not_authorized: "Not signed in",

    // Connection states
    state_disconnected: "Disconnected",
    state_connecting: "Connecting…",
    state_disconnecting: "Disconnecting…",
    state_connected: "Connected",

    // Home
    server_choose: "Choose a server",
    current_session: "Current session",
    downloaded: "Downloaded",
    session_time: "Time",
    traffic: "Traffic",
    subscription: "Subscription",
    free_tier_hint: "Free trial",
    trial_access_banner: "TEMPORARY TRIAL ACCESS",
    trial_access_title: "Temporary access",
    trial_access_description: "Trial access is issued once and ends quickly. Choose a plan to keep server access and avoid losing the connection after the trial expires.",
    trial_access_open_plans: "Plans",

    // Servers
    server_select: "Select a server",
    server_unavailable: "Unavailable",
    server_offline: "offline",
    servers_empty: "No servers available",
    servers_load_error: "Failed to load",
    plans_load_error: "Failed to load plans",
    refresh: "Refresh",
    country_NL: "Netherlands",
    country_DE: "Germany",
    country_US: "USA",
    country_GB: "United Kingdom",
    country_FI: "Finland",
    country_SE: "Sweden",
    country_FR: "France",
    country_JP: "Japan",
    country_SG: "Singapore",
    country_CA: "Canada",
    country_AU: "Australia",
    country_TR: "Turkey",

    // Settings
    settings: "Settings",
    account: "Account",
    telegram_id: "Telegram ID",
    plan: "Plan",
    plan_free: "Free",
    plan_standard: "Standard",
    plan_admin: "Admin",
    plan_expired: "Expired",
    devices_title: "Devices",
    devices_manage_hint: "View and disconnect devices linked to your account.",
    devices_count: "devices connected",
    devices_scan_qr: "Scan QR",
    devices_refresh: "Refresh",
    devices_this_device: "This device",
    devices_other_devices: "Other devices",
    devices_empty: "No other connected devices.",
    devices_disconnect: "Disconnect",
    devices_current_badge: "Current device",
    devices_type_phone: "Phone",
    devices_type_tv: "TV",
    devices_type_desktop: "Desktop",
    email_title: "Email",
    email_hint: "Email for the up-to-date subscription link",
    expires: "Expires",
    renew_in_bot: "Renew the subscription in @meow_meow_vpn_bot",
    email_not_set: "Not set",
    email_save: "Save",
    email_placeholder: "Enter email",
    email_error: "Could not save email",
    language: "Language",
    language_english: "English",
    language_russian: "Russian",
    language_restart_title: "Restart required",
    language_restart_message: "The app must be restarted to apply the new language.",
    language_restart_button: "Restart",
    cancel: "Cancel",
    about: "About",
    version: "Version",
    xray: "XRay",
    logout: "Sign out",

    // Stats
    stats_title: "Statistics",
    stats_total_used: "Total used",
    stats_your_stats: "Your statistics",
    stats_metric_sessions: "Sessions",
    stats_metric_time: "Time",
    stats_metric_avg: "Average",
    stats_period_day: "Day",
    stats_period_week: "Week",
    stats_period_month: "Month",
    stats_no_data: "No data for this period",
    stats_today_by_hour: "Today by hour",
    stats_week_by_day: "Week by day",
    stats_month_by_week: "Month by week",
    stats_sessions_short: "sessions",
    stats_week_short: "Wk.",
    back: "Back",

    // Subscription sheet
    current_plan: "Current plan",
    plan_limited_traffic: "Limited traffic",
    plan_unlimited_access: "Unlimited access",
    plan_active_until: "Active until {0}",
    plan_until: "until {0}",
    plan_quota_month: "XXX GB / month",
    plan_renew_full: "Renew subscription (XXX GB / month · up to XX devices)",
    unit_gb: "GB",
    per_month_short: "per month",
    devices_label: "devices",
    plan_traffic_month_fmt: "{0} GB / month",
    plan_devices_fmt: "up to {0} devices",
    plan_devices_unknown: "up to XX devices",
    plan_unlimited_traffic: "Unlimited traffic",
    available_plans: "Available plans",
    loading_data: "Loading…",
    plans_loading: "Loading plans…",
    payment_via_telegram: "Payment via Telegram",
    buy_plan: "Buy \"{0}\" for {1}",
    plan_day: "1 day",
    plan_week: "7 days",
    plan_month: "1 month",
    plan_3month: "3 months",
    plan_year: "1 year",
    subscription_qr_title: "Scan to purchase",
    subscription_qr_hint: "Scan with your phone to open @meow_meow_vpn_bot and continue purchase.",
    subscription_sync_hint: "The plan updates automatically after payment.",
    subscription_change_plan: "Choose another plan",
    close: "Close",

    // Speed test
    speed_test_title: "Speed test",
    speed_test_subtitle: "Check your internet speed",
    speed_press_start: "Press \"Start\"",
    speed_measuring_ping: "Measuring ping…",
    speed_downloading: "Downloading…",
    speed_done: "Test complete",
    speed_ping: "Ping",
    speed_download: "Download",
    speed_start_test: "Start test",
    speed_stop: "Stop",
    speed_unit_ms: "ms",
    speed_unit_mbps: "Mbps",
    speed_via_vpn: "Via VPN",
    speed_direct: "Direct",
    speed_no_connection: "No connection",
    speed_measure_failed: "Speed measurement failed",

    // In-app updater
    update_banner_title: "v{version} available",
    update_banner_download: "Download",
    update_banner_later: "Later",
    update_banner_downloading_title: "Downloading v{version}",
    update_banner_installing_privileged: "Downloading and installing the signed update…",
    update_banner_cancel: "Cancel",
    update_banner_ready_title: "v{version} ready",
    update_banner_ready_description: "Restart the app to apply the update.",
    update_banner_install: "Install",
    update_banner_failed_title: "Update failed",
    update_banner_retry: "Retry",
    update_check_button: "Check",
    update_check_button_loading: "Checking…",
    update_check_uptodate: "Version {version}",
    update_available_short: "Version {current} · v{version} available",
  },
} as const;

export type StringKey = keyof (typeof strings)["ru"];

export function t(key: StringKey, lang?: Lang): string {
  const l = lang ?? getSavedLang();
  return strings[l][key];
}

export function tf(key: StringKey, ...args: (string | number)[]): string {
  let s: string = t(key);
  args.forEach((v, i) => {
    s = s.replace(`{${i}}`, String(v));
  });
  return s;
}
