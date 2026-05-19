<div align="center">

<img src="src-tauri/icons/icon.png" alt="ToBeVPN" width="160" height="160" />

# ToBeVPN

**Современный VPN-клиент для Linux и Windows с подпиской, выбором серверов и встроенными обновлениями.**

[![Latest Release](https://img.shields.io/github/v/release/Shoolife/ToBeVPN-Desktop?display_name=tag&sort=semver&color=4CAF50&label=release)](https://github.com/Shoolife/ToBeVPN-Desktop/releases/latest)
[![Build](https://github.com/Shoolife/ToBeVPN-Desktop/actions/workflows/build.yml/badge.svg)](https://github.com/Shoolife/ToBeVPN-Desktop/actions/workflows/build.yml)
[![Linux](https://img.shields.io/badge/Linux-.deb-3A8DFF)](#)
[![Windows](https://img.shields.io/badge/Windows-NSIS-3A8DFF)](#)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=0B1727)](#)

</div>

---

## Что это

ToBeVPN — нативный desktop-клиент к VPN-сети с защищённым подключением, управлением подпиской и привязкой устройств. Авторизация через Telegram, список серверов с пингом, статистика трафика, speed test, встроенный обновлятор, безопасное локальное хранение device-session токенов — всё это.

## Главное

| | |
|--|--|
| 🛡️ **VLESS Reality** | Xray-core внутри, routing через tun2socks / TUN |
| 🖥️ **Linux / Windows** | `.deb` для Linux и NSIS installer для Windows |
| 🔐 **Авторизация** | Без логина/пароля, Telegram flow, HWID-привязка desktop-устройства |
| 💳 **Подписка** | Текущий тариф, лимиты, устройства, пробный доступ и сценарии оплаты через backend flow |
| 🌍 **Выбор сервера** | Список нод с пингом, статусом доступности и сохранением последнего выбора |
| 📈 **Статистика** | Локальные сессии, длительность подключения и трафик |
| 🚦 **Speed test** | Замер скорости подключения из приложения |
| 💻 **Устройства** | Просмотр связанных устройств и отвязка текущего desktop-клиента |
| 🔄 **In-app updater** | Проверка `latest.json`, подписи `.sig`, установка обновлений из GitHub Releases |
| 🔑 **Linux polkit helpers** | После установки `.deb` VPN и обновления работают без повторных запросов пароля |
| 🌗 **Light / Dark / RU / EN** | React UI, ручное переключение темы и языка |
| 🛟 **Fallback proxy** | При недоступности основного бэкенда — автоматический повтор через резервный proxy-маршрут |

## Скриншоты

<div align="center">
  <table>
    <tr>
      <td align="center"><b>Home</b></td>
      <td align="center"><b>Серверы</b></td>
      <td align="center"><b>Подписка</b></td>
      <td align="center"><b>Настройки</b></td>
    </tr>
    <tr>
      <td><sub><i>скриншот скоро</i></sub></td>
      <td><sub><i>скриншот скоро</i></sub></td>
      <td><sub><i>скриншот скоро</i></sub></td>
      <td><sub><i>скриншот скоро</i></sub></td>
    </tr>
  </table>
</div>

## Стек

- **UI:** React 19, TypeScript 5.8, Vite 7
- **Desktop shell:** Tauri 2, Rust 2021, tray icon, single-instance, updater plugin
- **Сеть:** Tauri HTTP plugin, fallback retry layer, request timeouts
- **VPN-движок:** Xray-core + tun2socks sidecar binaries
- **Хранилище:** localStorage для UI-состояния, platform keyring для device-session токенов
- **Linux privileges:** polkit policy + installed helper scripts
- **CI:** GitHub Actions, audit-gate, авто-сборка `.deb` + `.exe`, релиз на тег `v*`

```
src/
├── api/               typed bot API client, fallback routing, DTO
├── components/        subscription sheet, update banner, spinner
├── screens/           Home / Servers / Settings / Stats / SpeedTest / Devices / Pairing
└── session/           Auth / Vpn / Stats / Updater / SecureSession

src-tauri/
├── src/
│   ├── vpn/           VpnManager, platform managers, Xray config, state
│   ├── lib.rs         Tauri commands, tray, secure storage, app setup
│   └── linux_update.rs
├── icons/
└── tauri.conf.json

scripts/
├── inject-backend-host.sh
├── restore-placeholder.sh
├── tobevpn-helper.sh
├── tobevpn-update-helper.sh
└── app.tobevpn.*.policy
```

## Сборка

### Требования
- Node.js 22+
- Rust stable
- Tauri CLI 2 (можно через `npx tauri ...`)
- Linux build dependencies: WebKitGTK 4.1, GTK, Ayatana AppIndicator, librsvg, libsoup
- Для локальной release-сборки: sidecar-бинарники Xray-core и tun2socks в `src-tauri/bin/`

### Локально

```bash
git clone https://github.com/Shoolife/ToBeVPN-Desktop.git
cd ToBeVPN-Desktop
npm ci
cp .env.example .env
```

Заполни `.env`:

```properties
VITE_BOT_API_URL=https://your-backend.example/
VITE_PANEL_URL=https://your-panel.example/

# Резервный путь к bot API (опционально). Полный URL proxy-function с параметром ?u=.
VITE_FALLBACK_BOT_DOMAIN=https://<fallback-host>/<function-id>?u=

# Резервный URL подписки (опционально). Полный URL заканчивающийся на ?sub=.
VITE_FALLBACK_SUBS_DOMAIN=https://<fallback-host>/<function-id>?sub=
```

Дальше:

```bash
npm run tauri dev              # desktop dev-приложение
npm run build                  # typecheck + Vite build
npx tauri build --bundles deb  # Linux .deb
npx tauri build --bundles nsis # Windows installer
npm run restore-host           # вернуть placeholders после локальной сборки
```

> `npm run inject-host` подставляет backend-хосты в `src-tauri/tauri.conf.json` и `src-tauri/capabilities/default.json`. После локальной сборки запускай `npm run restore-host`, чтобы реальные адреса не остались в рабочем дереве.

### CI / Releases

Тег `v*` запускает [workflow](.github/workflows/build.yml), который:
1. Проверяет зависимости через `npm audit` и `cargo audit`.
2. Скачивает Xray-core, tun2socks и Wintun.
3. Инжектит backend hostnames из CI-секретов.
4. Собирает Linux `.deb` и Windows NSIS installer.
5. Создаёт `.sig` подписи для Tauri updater.
6. Генерирует `latest.json`.
7. Публикует release assets в GitHub Releases.

Release assets:
- `ToBeVPN_<version>_amd64.deb`
- `ToBeVPN_<version>_amd64.deb.sig`
- `ToBeVPN_<version>_x64-setup.exe`
- `ToBeVPN_<version>_x64-setup.exe.sig`
- `latest.json`

Секреты репозитория, которые нужны:
- `BOT_API_HOST`
- `PANEL_HOST`
- `FALLBACK_BOT_DOMAIN` / `FALLBACK_SUBS_DOMAIN` *(опционально, если включаешь fallback-маршрутизацию)*
- `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Xray-core обновляется только через обычный app release: release workflow каждый раз скачивает актуальный sidecar. [check-xray-core](.github/workflows/check-xray-core.yml) ежедневно сравнивает upstream Xray-core с последним релизом приложения и создаёт issue, если нужен маленький patch release с обновлённым core.

## Linux privileges

Для системного VPN на Linux приложению нужно управлять TUN-интерфейсом, маршрутами и DNS. `.deb` устанавливает ограниченные polkit helpers:

- `/usr/local/bin/tobevpn-helper.sh`
- `/usr/local/bin/tobevpn-update-helper.sh`
- `/usr/share/polkit-1/actions/app.tobevpn.network.policy`
- `/usr/share/polkit-1/actions/app.tobevpn.update.policy`

После первого системного разрешения start/stop VPN и установка подписанного `.deb`-обновления выполняются без постоянных повторных запросов пароля.

## Безопасность

- Backend-хосты **не** хардкодятся в исходниках — инжектятся при сборке через `.env` или CI-секреты.
- CSP и Tauri HTTP scope собираются с конкретными разрешёнными hostnames.
- Auth/session токены сохраняются в **platform keyring**; если keyring недоступен, используется локальный fallback.
- VPN helper payload'ы на Linux staging'ятся в пользовательском cache-dir с ограниченными правами, не через world-writable `/tmp`.
- Обновления проверяются через **Tauri updater** и `.sig` подписи.
- API-запросы имеют timeout и fallback retry, чтобы broken tunnel не подвешивал интерфейс.
- Expired/sentinel server отсекается до передачи в VPN-движок.

Подробнее — `src/session/secureSession.ts`, `src/api/client.ts`, `src-tauri/src/vpn/manager_linux.rs`, `src-tauri/src/linux_update.rs`.

## Связанные репозитории

- **Android-клиент:** [ToBeVPN-Android](https://github.com/Shoolife/ToBeVPN-Android) — нативный Android-клиент на Kotlin + Jetpack Compose

## Roadmap

- [ ] macOS release target
- [ ] Auto-server selection по latency
- [ ] Расширенная статистика по периодам
- [ ] Более подробные release notes
- [ ] Скриншоты для README

## Contributing

Issue welcome. PR — лучше предварительно обсудить через issue, особенно если затрагивает VPN-engine, auth-flow, updater или privilege helpers. Стиль кода — TypeScript strict + Rust 2021, форматирование — локальные default tools. Коммиты — present tense, conventional commits не обязательны но приветствуются.

## Лицензия

Проприетарное приложение. Исходный код предоставляется для прозрачности и self-host'инга — коммерческое использование/перепродажа запрещены.

---

<div align="center">
  <sub>Сделано с ❤️ командой <b>ToBeVPN × Meow VPN</b></sub>
</div>
