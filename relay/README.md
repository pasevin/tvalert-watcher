# TradingView Alerts — Relay Server

A small standalone service that makes the TradingView Alerts app usable by non-technical
users: it gives each account a **permanent public webhook URL** and forwards TradingView
alerts to their Mac app over a WebSocket — no tunnel, no localhost, no setup.

This is a **separate deployable** from the desktop app (it is not bundled into the app
and is not part of the Glaze build). Persistence is SQLite (better-sqlite3) on a mounted
volume; accounts use magic-link email sign-in; billing is Stripe.

## How it works

```
TradingView ──POST /hook/:token──▶  relay  ──WebSocket /ws?token=──▶  Mac app
```

1. The app signs the user in (magic link) and calls `POST /register` to get its stable `token`.
2. The user pastes their personal URL `https://<host>/hook/<token>` into TradingView.
3. The app holds a WebSocket open; alerts are pushed instantly. Alerts that arrive while
   the app is offline are **persisted per account** (durable SQLite queue, up to 7 days /
   200 alerts) and flushed in order on reconnect.

## Plans

- **Hosted relay is Pro-only.** `/hook` delivers alerts only for accounts with an active
  Pro subscription; non-Pro accounts get a `{ type:"limit" }` upsell message instead.
- **Free = self-host.** Run this relay with `REQUIRE_AUTH=false` (no accounts, unlimited) or
  use the app's built-in local webhook. `/health` advertises `requiresAuth` so the app
  auto-detects a self-hosted relay and skips sign-in.

## Endpoints

| Method | Path                     | Auth           | Purpose                                              |
| ------ | ------------------------ | -------------- | ---------------------------------------------------- |
| GET    | `/health`                | —              | Liveness, connection count, `requiresAuth`           |
| POST   | `/auth/request`          | —              | `{ email }` → `{ pollToken }`; emails a magic link   |
| GET    | `/auth/verify`           | link token     | Opened in browser; consumes link, creates session    |
| POST   | `/auth/poll`             | poll token     | App polls → `{ status, sessionToken, email, pro }`   |
| POST   | `/auth/signout`          | Bearer         | Invalidate the session                               |
| POST   | `/register`              | Bearer¹        | Account's stable webhook token → `{ token, hookUrl }`|
| GET    | `/me`                    | Bearer         | `{ email, pro, portalUrl, hookUrl, usage }`          |
| GET    | `/billing/checkout`      | Bearer         | `?plan=monthly\|yearly` → Stripe Checkout `{ url }`  |
| GET    | `/billing/portal`        | Bearer         | Stripe billing-portal session `{ url }`              |
| POST   | `/billing/stripe/webhook`| Stripe sig     | Subscription events → flip Pro                       |
| GET    | `/privacy`, `/terms`     | —              | Hosted legal pages (rendered from `legal/*.md`)      |
| POST   | `/hook/:token`           | token (URL)    | Receive a TradingView alert (Pro-gated delivery)     |
| WS     | `/ws?token=…`            | token (URL)    | App connection; receives `{ type:"alert"\|"limit"\|"entitlement"\|"welcome" }` |
| POST   | `/admin/pro`             | x-admin-secret | Manual Pro override (testing/support)                |

¹ In self-host mode (`REQUIRE_AUTH=false`) `/register` needs no Bearer and returns an
unlimited token.

## Auth (poll-based magic link — no deep links)

1. App `POST /auth/request { email }` → `{ pollToken }` (relay emails a link via Resend).
2. User clicks link → `GET /auth/verify?token=…` → session created, "signed in" page.
3. App polls `POST /auth/poll { pollToken }` → `{ sessionToken, email, pro }`.
4. App `POST /register` (Bearer session) → stable `hookUrl` to paste into TradingView.

## Billing (Stripe)

`PAYMENT_PROVIDER=stripe`. `/billing/checkout` creates a subscription Checkout Session
(monthly/yearly price); the `/billing/stripe/webhook` (signature-verified) flips the
account's Pro flag on `checkout.session.completed` / `customer.subscription.updated|deleted`
and pushes a live `entitlement` message to the connected app. `/billing/portal` opens the
Stripe customer portal. (LemonSqueezy support exists behind `PAYMENT_PROVIDER=lemonsqueezy`
but is on hold.)

## Configuration

Non-secret (`fly.toml` `[env]`): `PORT`, `PUBLIC_BASE_URL`, `DB_PATH`, `PAYMENT_PROVIDER`,
`REQUIRE_AUTH`.

Secrets (`fly secrets set`):

- `RESEND_API_KEY`, `MAIL_FROM` — magic-link email (without a key, links are logged to
  `fly logs` for dev only).
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PORTAL_CONFIG_ID` — Stripe billing + portal.
- `ADMIN_SECRET` — guards `/admin/pro`.

## Run locally

```bash
cd relay
npm install
REQUIRE_AUTH=false DB_PATH=./relay.db PORT=8787 npm start
```

`REQUIRE_AUTH=false` runs it in self-host mode (no accounts/billing). Point the app's
relay URL at `http://localhost:8787` (Settings → Local Webhook (Advanced) → Relay Server).

## Deploy (Fly.io)

```bash
cd relay
fly apps create <app-name> --org personal                 # once
fly volumes create alert_watcher_data --region iad --size 1   # persistent SQLite
fly secrets set RESEND_API_KEY="re_..." MAIL_FROM="TradingView Alerts <noreply@yourdomain>"
fly secrets set STRIPE_SECRET_KEY="sk_live_..." STRIPE_PRICE_MONTHLY="price_..." \
                STRIPE_PRICE_YEARLY="price_..." STRIPE_WEBHOOK_SECRET="whsec_..." \
                ADMIN_SECRET="$(openssl rand -hex 16)"
fly deploy --ha=false
# one-time, on the machine, to create the Stripe customer-portal config:
fly ssh console -C "node scripts/setup-portal.js"   # then set STRIPE_PORTAL_CONFIG_ID
```

- Set `PUBLIC_BASE_URL` (in `fly.toml` `[env]`) to your public HTTPS URL so generated
  `hookUrl`s and legal links are correct.
- A persistent volume mounted at `/data` (see `[mounts]`) holds the SQLite DB.
- Keep `.dockerignore` excluding `node_modules` — otherwise a host-built `better-sqlite3`
  binary gets copied into the image and crashes with "invalid ELF header".
- `--ha=false` keeps a single always-on machine (needed for persistent WebSockets).

## Hardening TODO (before scale)

- **Single machine = single point of failure.** SQLite-on-volume is fine for launch; move
  to LiteFS or Postgres for HA / multi-region.
- Tighten rate limits (`/auth/request`, `/register` are limited; consider per-account hook
  limits and `/hook` abuse protection).
- Rotate any secrets that were ever exposed.
