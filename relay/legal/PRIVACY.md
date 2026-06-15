# Privacy Policy — TradingView Alerts

_Last updated: June 13, 2026_

TradingView Alerts ("we", "us") is operated by **Behype Inc.**, a company
registered in Delaware, USA. This policy explains what we collect and why.
Questions: pasevin@gmail.com.

## What we collect

- **Email address** — when you sign in. Used to authenticate you (magic link) and
  to associate your subscription. We do not send marketing email without consent.
- **Subscription data** — when you upgrade, our payment processor (Stripe) creates a
  customer and subscription. We store a Stripe customer identifier and your plan
  status (free/Pro). **We never see or store your card details** — Stripe handles
  payment data directly ([stripe.com/privacy](https://stripe.com/privacy)).
- **Webhook token & usage counts** — a random identifier for your personal webhook
  URL, and a per-day count of alerts relayed (to enforce plan limits).
- **Alert content (transient)** — TradingView alert payloads you send are forwarded
  to your app in real time. If your app is offline, up to 50 recent alerts are held
  briefly in memory and removed once delivered. We do not persist alert history on
  our servers; your alert list lives locally in the app on your Mac.

## Third parties (sub-processors)

- **Stripe** — payments and subscription management.
- **Resend** — transactional email (sign-in links).
- **Fly.io** — hosting of the relay service.

## Data retention & deletion

- We keep your account (email, plan, token) until you delete it. Sign out removes the
  session from your device; to delete your account and data, contact pasevin@gmail.com.
- Transient relayed alerts are not retained after delivery.

## Self-hosting

TradingView Alerts is open source. If you self-host the relay or use the local-webhook
mode, your data does not pass through our servers at all.

## Your rights

Depending on your region (e.g. GDPR/CCPA) you may request access, correction, or
deletion of your data. Contact pasevin@gmail.com.

## Changes

We may update this policy; material changes will be noted with a new "Last updated" date.
