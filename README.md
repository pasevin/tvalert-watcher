# TradingView Alerts

A native macOS menu-bar app that notifies you the instant your **TradingView alerts**
fire — native notification, menu-bar badge, sound, and a dropdown of recent alerts.

TradingView sends alerts as webhooks from its cloud, so they need a public URL to
reach your Mac. TradingView Alerts gives you three ways to handle that:

| Mode | Setup | Cost |
| --- | --- | --- |
| **Local webhook** | Run your own tunnel (e.g. `ngrok`) to the built-in local server | Free |
| **Self-hosted relay** | Deploy the included relay yourself (no account needed) | Free |
| **Hosted relay (Pro)** | Sign in — your personal URL works the moment you install | Subscription |

The app and the relay are the **same open-source code**. The paid tier is purely the
convenience of a managed, zero-setup hosted relay.

## How it works

```
TradingView ──HTTPS POST──▶  relay  ──WebSocket──▶  TradingView Alerts (menu bar)
```

You paste one URL into TradingView's alert webhook field. The app holds a WebSocket
to the relay and shows alerts in real time (notification + badge + sound + list).

## Repository layout

```
.
├── main/            # App backend (Node) — tray, webhook server, relay client, IPC
├── renderer/        # App frontend (React) — menu popover + Settings
├── relay/           # Standalone hosted/self-host relay server (separate deployable)
└── LICENSE          # AGPL-3.0
```

## Run the app (development)

Requires the [Glaze](https://glaze.app) runtime.

```bash
npm install
# build & launch via the Glaze tooling
```

## Self-host the relay (free, no account)

Run the relay with auth disabled and point the app at it
(Settings → Local Webhook → Relay Server):

```bash
cd relay
npm install
REQUIRE_AUTH=false PORT=8787 DB_PATH=./relay.db PUBLIC_BASE_URL="https://your-host" npm start
```

The app auto-detects the no-auth relay (via `/health`) and skips sign-in entirely.
See [`relay/README.md`](relay/README.md) for Fly.io deployment, persistence, and the
hosted (accounts + Pro) configuration.

## Hosted (Pro)

The official hosted relay adds magic-link accounts and an always-on managed server,
so it works the moment you install — no tunnel, no deploy. This funds the project.

## License

[AGPL-3.0](LICENSE). You're free to use, modify, and self-host. If you run a modified
version as a network service, you must publish your changes under the same license.
