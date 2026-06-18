// TradingView Alerts — hosted webhook relay (Phase 2)
//
// Magic-link email accounts, persistent account-bound webhook tokens (SQLite),
// Pro/free entitlement gating, and real-time alert forwarding over WebSocket.
//
//   TradingView ──POST /hook/:token──▶ relay ──WS /ws?token=──▶ Mac app
//
// Auth (no deep-linking — poll-based so it works in a sandboxed webview):
//   1. app  POST /auth/request { email }            → { pollToken } (+ emails link)
//   2. user clicks link → GET /auth/verify?token=…  → creates session, shows page
//   3. app  POST /auth/poll { pollToken }           → { sessionToken, email, pro }
//   4. app  POST /register  (Bearer session)        → { token, hookUrl } (stable)

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

import { WebSocketServer } from "ws";
import Stripe from "stripe";

import * as store from "./db.js";
import { sendMagicLink } from "./mailer.js";
import { renderLegal } from "./legal.js";

// Marketing landing page (served at /). DOWNLOAD_URL auto-resolves to the
// latest GitHub release DMG — no need to update on each release.
const GITHUB_REPO = "pasevin/tradingview-alerts";
let cachedDownloadUrl = null;
let cachedAt = 0;

async function getDownloadUrl() {
  // Cache for 1 hour
  if (cachedDownloadUrl && Date.now() - cachedAt < 3600000) return cachedDownloadUrl;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "User-Agent": "tvalert-relay" } }
    );
    const release = await res.json();
    const dmg = release.assets?.find(a => a.name.endsWith(".dmg"));
    if (dmg) {
      cachedDownloadUrl = dmg.browser_download_url;
      cachedAt = Date.now();
      return cachedDownloadUrl;
    }
  } catch (e) {
    // fall through to env var or fallback
  }
  return process.env.DOWNLOAD_URL || `https://github.com/${GITHUB_REPO}/releases/latest`;
}
let landingHtml = null;
async function getLanding() {
  const downloadUrl = await getDownloadUrl();
  if (landingHtml === null) {
    landingHtml = readFileSync(new URL("./site.html", import.meta.url), "utf-8");
  }
  return landingHtml.replaceAll("__DOWNLOAD_URL__", downloadUrl);
}

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET; // optional: toggle Pro for testing
// Self-host mode: set REQUIRE_AUTH=false to disable accounts/Pro entirely — the
// relay issues a single anonymous (unlimited) token with no email/sign-in needed.
// The hosted instance keeps this true so Pro can be enforced.
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== "false";
// Billing provider: "stripe" (active) or "lemonsqueezy" (on hold).
const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || "stripe";

// Stripe config.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY; // recurring monthly price (price_...)
const STRIPE_PRICE_YEARLY = process.env.STRIPE_PRICE_YEARLY; // recurring yearly price (price_...)
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PORTAL_CONFIG_ID = process.env.STRIPE_PORTAL_CONFIG_ID; // billing portal configuration
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const STRIPE_ACTIVE_STATUSES = ["active", "trialing", "past_due"];

// LemonSqueezy config (on hold). CHECKOUT_URL is the product's buy link; the
// WEBHOOK_SECRET is the signing secret from the LemonSqueezy dashboard.
const LEMONSQUEEZY_CHECKOUT_URL = process.env.LEMONSQUEEZY_CHECKOUT_URL;
const LEMONSQUEEZY_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

// Push an entitlement update to a connected app (by account).
function pushEntitlement(account) {
  const token = store.getTokenForAccount(account.id);
  if (token) {
    sendLive(token, { type: "entitlement", pro: !!account.pro, portalUrl: account.portal_url ?? null });
  }
}
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // offline alerts kept up to 7 days

/** token -> Set<WebSocket> (live app connections) */
const connections = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function html(res, code, body) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function bearer(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function clientIp(req) {
  return (
    req.headers["fly-client-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// Simple in-memory fixed-window rate limiter (single-machine relay).
const rateBuckets = new Map(); // key -> { count, resetAt }
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > max;
}
// Periodic cleanup of expired buckets.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (b.resetAt < now) rateBuckets.delete(k);
}, 10 * 60 * 1000).unref?.();

function readBody(req, res) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        json(res, 413, { ok: false, error: "Payload too large" });
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(aborted ? null : body));
    req.on("error", () => resolve(null));
  });
}

function parseJson(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

// Send a message to any live connections for a token. Returns true if it
// reached at least one open socket. Does NOT queue (transient messages only).
function sendLive(token, message) {
  const set = connections.get(token);
  if (!set) return false;
  const data = JSON.stringify(message);
  let delivered = false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      delivered = true;
    }
  }
  return delivered;
}

const signedInPage = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f5f5f7;color:#1d1d1f}
.card{background:#fff;padding:40px 48px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center;max-width:360px}
h1{font-size:20px;margin:0 0 8px}p{color:#6e6e73;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>✅ You're signed in</h1><p>You can close this tab and return to TradingView Alerts.</p></div></body></html>`;

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/health") {
      // `requiresAuth` lets the app auto-detect self-host (no-account) relays.
      return json(res, 200, { ok: true, connections: connections.size, requiresAuth: REQUIRE_AUTH });
    }

    // App icon.
    if (req.method === "GET" && pathname === "/icon.png") {
      const buf = readFileSync(new URL("./icon.png", import.meta.url));
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      return res.end(buf);
    }

    // Marketing landing page.
    if (req.method === "GET" && pathname === "/") {
      return html(res, 200, await getLanding());
    }

    // Public legal pages (for Stripe + app links).
    if (req.method === "GET" && (pathname === "/privacy" || pathname === "/terms")) {
      return html(res, 200, renderLegal(pathname.slice(1)));
    }

    // 1. Request a magic-link sign-in.
    if (req.method === "POST" && pathname === "/auth/request") {
      // Throttle to curb email-bombing: 5 requests / 10 min per IP.
      if (rateLimited(`auth:${clientIp(req)}`, 5, 10 * 60 * 1000)) {
        return json(res, 429, { ok: false, error: "Too many sign-in requests. Try again later." });
      }
      const { email } = parseJson(await readBody(req, res));
      if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json(res, 400, { ok: false, error: "Valid email required" });
      }
      const { linkToken, pollToken } = store.createMagicLink(email, MAGIC_LINK_TTL_MS);
      const link = `${PUBLIC_BASE_URL}/auth/verify?token=${linkToken}`;
      try {
        await sendMagicLink(email, link);
      } catch (err) {
        console.error("[auth:request] email send failed", err);
        return json(res, 502, { ok: false, error: "Could not send email" });
      }
      console.log("[auth:request]", { email });
      return json(res, 200, { ok: true, pollToken });
    }

    // 2. Verify the link (opened in the user's browser).
    if (req.method === "GET" && pathname === "/auth/verify") {
      const token = url.searchParams.get("token") || "";
      const result = store.consumeMagicLink(token);
      if (!result.ok) {
        return html(res, 400, `<p>This sign-in link is ${result.reason === "expired" ? "expired" : "invalid"}. Please request a new one from the app.</p>`);
      }
      console.log("[auth:verify]", { email: result.email });
      return html(res, 200, signedInPage);
    }

    // 3. App polls until the link is clicked.
    if (req.method === "POST" && pathname === "/auth/poll") {
      const { pollToken } = parseJson(await readBody(req, res));
      if (typeof pollToken !== "string") return json(res, 400, { ok: false, error: "pollToken required" });
      return json(res, 200, store.pollMagicLink(pollToken));
    }

    // 4. Register / fetch the account's stable webhook token.
    //    Hosted: requires a Bearer session. Self-host (no-auth): anonymous.
    if (req.method === "POST" && pathname === "/register") {
      // 30 registrations / hour per IP (the app registers rarely).
      if (rateLimited(`register:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
        return json(res, 429, { ok: false, error: "Too many requests. Try again later." });
      }
      const account = REQUIRE_AUTH
        ? store.getAccountBySession(bearer(req))
        : store.getOrCreateSelfHostAccount();
      if (!account) return json(res, 401, { ok: false, error: "Sign in required" });
      const token = store.getOrCreateWebhookToken(account.id);
      return json(res, 200, { token, hookUrl: `${PUBLIC_BASE_URL}/hook/${token}` });
    }

    // Account info for the signed-in app.
    if (req.method === "GET" && pathname === "/me") {
      const account = store.getAccountBySession(bearer(req));
      if (!account) return json(res, 401, { ok: false, error: "Sign in required" });
      const token = store.getOrCreateWebhookToken(account.id);
      return json(res, 200, {
        email: account.email,
        pro: !!account.pro,
        portalUrl: account.portal_url ?? null,
        hookUrl: `${PUBLIC_BASE_URL}/hook/${token}`,
        usage: store.getUsage(account.id),
      });
    }

    // Build a checkout URL for the signed-in account.
    if (req.method === "GET" && pathname === "/billing/checkout") {
      const account = store.getAccountBySession(bearer(req));
      if (!account) return json(res, 401, { ok: false, error: "Sign in required" });

      if (PAYMENT_PROVIDER === "stripe") {
        const plan = url.searchParams.get("plan") === "yearly" ? "yearly" : "monthly";
        const price = plan === "yearly" ? STRIPE_PRICE_YEARLY : STRIPE_PRICE_MONTHLY;
        if (!stripe || !price) return json(res, 503, { ok: false, error: "Billing not configured" });
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price, quantity: 1 }],
          customer_email: account.email,
          client_reference_id: account.email,
          subscription_data: { metadata: { account_email: account.email } },
          allow_promotion_codes: true,
          success_url: `${PUBLIC_BASE_URL}/billing/return?status=success`,
          cancel_url: `${PUBLIC_BASE_URL}/billing/return?status=cancel`,
        });
        return json(res, 200, { url: session.url });
      }

      // LemonSqueezy (on hold)
      if (!LEMONSQUEEZY_CHECKOUT_URL) return json(res, 503, { ok: false, error: "Billing not configured" });
      const u = new URL(LEMONSQUEEZY_CHECKOUT_URL);
      u.searchParams.set("checkout[email]", account.email);
      u.searchParams.set("checkout[custom][account_email]", account.email);
      return json(res, 200, { url: u.toString() });
    }

    // Return a fresh "manage subscription" URL for the signed-in account.
    if (req.method === "GET" && pathname === "/billing/portal") {
      const account = store.getAccountBySession(bearer(req));
      if (!account) return json(res, 401, { ok: false, error: "Sign in required" });

      if (PAYMENT_PROVIDER === "stripe") {
        if (!stripe || !account.stripe_customer) {
          return json(res, 404, { ok: false, error: "No subscription to manage" });
        }
        const portal = await stripe.billingPortal.sessions.create({
          customer: account.stripe_customer,
          return_url: `${PUBLIC_BASE_URL}/billing/return`,
          ...(STRIPE_PORTAL_CONFIG_ID ? { configuration: STRIPE_PORTAL_CONFIG_ID } : {}),
        });
        return json(res, 200, { url: portal.url });
      }

      // LemonSqueezy: stored portal URL
      if (!account.portal_url) return json(res, 404, { ok: false, error: "No subscription to manage" });
      return json(res, 200, { url: account.portal_url });
    }

    // Simple post-checkout landing page.
    if (req.method === "GET" && pathname === "/billing/return") {
      return html(
        res,
        200,
        signedInPage
          .replace("✅ You're signed in", "✅ All done")
          .replace("You can close this tab and return to TradingView Alerts.", "You can close this tab and return to TradingView Alerts — your plan updates automatically."),
      );
    }

    // Stripe billing webhook → flip Pro entitlement.
    if (req.method === "POST" && pathname === "/billing/stripe/webhook") {
      const raw = await readBody(req, res);
      if (raw === null) return;
      if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        console.error("[billing] stripe webhook received but Stripe not configured");
        return json(res, 503, { ok: false, error: "Billing not configured" });
      }
      let event;
      try {
        event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.error("[billing] invalid stripe signature", err.message);
        return json(res, 400, { ok: false, error: "Invalid signature" });
      }

      try {
        if (event.type === "checkout.session.completed") {
          const s = event.data.object;
          const email = s.client_reference_id || s.customer_details?.email || s.customer_email;
          if (email) {
            const account = store.setProByEmail(email, true, "stripe");
            if (s.customer) store.setStripeCustomer(account.id, s.customer);
            pushEntitlement(store.getAccountById(account.id));
            console.log("[billing:stripe] checkout.completed", { email, customer: s.customer });
          }
        } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
          const sub = event.data.object;
          const account = store.getAccountByStripeCustomer(sub.customer);
          if (account) {
            const pro = event.type === "customer.subscription.deleted" ? false : STRIPE_ACTIVE_STATUSES.includes(sub.status);
            const updated = store.setProByEmail(account.email, pro, "stripe");
            pushEntitlement(updated);
            console.log("[billing:stripe]", { event: event.type, email: account.email, status: sub.status, pro });
          } else {
            console.log("[billing:stripe] no account for customer", sub.customer);
          }
        } else {
          console.log("[billing:stripe] ignored", { event: event.type });
        }
      } catch (err) {
        console.error("[billing:stripe] handler error", err);
      }
      return json(res, 200, { received: true });
    }

    // LemonSqueezy billing webhook → flip Pro entitlement.
    if (req.method === "POST" && pathname === "/billing/webhook") {
      const raw = await readBody(req, res);
      if (raw === null) return;
      if (!LEMONSQUEEZY_WEBHOOK_SECRET) {
        console.error("[billing] webhook received but LEMONSQUEEZY_WEBHOOK_SECRET unset");
        return json(res, 503, { ok: false, error: "Billing not configured" });
      }
      // Verify HMAC-SHA256 signature over the raw body.
      const signature = String(req.headers["x-signature"] || "");
      const expected = crypto.createHmac("sha256", LEMONSQUEEZY_WEBHOOK_SECRET).update(raw).digest("hex");
      const valid =
        signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      if (!valid) {
        console.error("[billing] invalid webhook signature");
        return json(res, 401, { ok: false, error: "Invalid signature" });
      }

      const payload = parseJson(raw);
      const eventName = payload?.meta?.event_name ?? "";
      const attrs = payload?.data?.attributes ?? {};
      const email = payload?.meta?.custom_data?.account_email || attrs.user_email;

      if (eventName.startsWith("subscription_") && email) {
        const status = attrs.status; // active, on_trial, past_due, cancelled, expired, ...
        let pro;
        if (["active", "on_trial", "past_due"].includes(status)) {
          pro = true;
        } else if (status === "cancelled") {
          // Cancelled but still within the paid period → keep Pro until ends_at.
          pro = attrs.ends_at ? new Date(attrs.ends_at).getTime() > Date.now() : false;
        } else {
          pro = false; // expired, unpaid, paused
        }
        const portalUrl = attrs.urls?.customer_portal ?? null;
        const account = store.setProByEmail(email, pro, portalUrl);
        console.log("[billing:webhook]", { event: eventName, email, status, pro });

        // Push the new entitlement to the user's connected app, if any.
        const token = store.getTokenForAccount(account.id);
        if (token) sendLive(token, { type: "entitlement", pro: !!account.pro, portalUrl: account.portal_url ?? null });
      } else {
        console.log("[billing:webhook] ignored", { event: eventName });
      }
      return json(res, 200, { ok: true });
    }

    // Sign out — invalidate the session.
    if (req.method === "POST" && pathname === "/auth/signout") {
      const session = bearer(req);
      if (session) store.deleteSession(session);
      return json(res, 200, { ok: true });
    }

    // Admin: toggle Pro for an email (Phase 3 billing webhook will do this).
    if (req.method === "POST" && pathname === "/admin/pro") {
      if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) {
        return json(res, 403, { ok: false, error: "Forbidden" });
      }
      const { email, pro } = parseJson(await readBody(req, res));
      const account = store.setPro(email, !!pro);
      return json(res, 200, { ok: true, email: account.email, pro: !!account.pro });
    }

    // Incoming TradingView webhook.
    const hookMatch = pathname.match(/^\/hook\/([A-Za-z0-9_-]+)$/);
    if (req.method === "POST" && hookMatch) {
      const token = hookMatch[1];
      const account = store.getAccountByToken(token);
      if (!account) return json(res, 404, { ok: false, error: "Unknown token" });

      const body = await readBody(req, res);
      if (body === null) return; // response already sent (too large / error)

      // Hosted relay is Pro-only — no free alerts. (Self-host accounts are
      // flagged pro=1, so they always pass; free = run your own relay.)
      if (!account.pro) {
        sendLive(token, {
          type: "limit",
          receivedAt: Date.now(),
          message: "Upgrade to Pro to receive your TradingView alerts — or self-host the relay for free.",
        });
        console.log("[relay:hook] not pro — upsell", { account: account.id });
        return json(res, 200, { ok: true, upgrade_required: true });
      }
      store.incrementUsage(account.id);

      // Deliver live, or persist for delivery when the app reconnects (Pro perk:
      // durable offline queue, kept up to 7 days / 200 alerts per account).
      const alertMsg = { type: "alert", id: crypto.randomUUID(), receivedAt: Date.now(), raw: body };
      const delivered = sendLive(token, alertMsg);
      if (!delivered) store.enqueueAlert(account.id, JSON.stringify(alertMsg));
      console.log("[relay:hook]", { account: account.id, delivered, queued: !delivered });
      return json(res, 200, { ok: true });
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    console.error("[relay] request error", err);
    if (!res.headersSent) json(res, 500, { ok: false, error: "Internal error" });
  }
});

// ── WebSocket server (app clients) ─────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const token = url.searchParams.get("token");
  const account = token ? store.getAccountByToken(token) : null;

  if (!account) {
    ws.close(1008, "invalid token");
    return;
  }

  if (!connections.has(token)) connections.set(token, new Set());
  connections.get(token).add(ws);
  ws.isAlive = true;
  console.log("[relay:ws-connect]", { account: account.id });

  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("close", () => {
    const set = connections.get(token);
    if (set) {
      set.delete(ws);
      if (set.size === 0) connections.delete(token);
    }
  });

  ws.send(JSON.stringify({ type: "welcome", pro: !!account.pro }));
  // Flush alerts that arrived while this account was offline (durable Pro queue).
  for (const payload of store.drainQueuedAlerts(account.id)) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
});

// Periodically prune expired queued alerts.
setInterval(() => store.pruneQueuedAlerts(QUEUE_TTL_MS), 60 * 60 * 1000).unref?.();

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(
    `[relay] listening on :${PORT} — public base ${PUBLIC_BASE_URL} ` +
      `(auth ${REQUIRE_AUTH ? "on" : "OFF — self-host mode"}, billing ${PAYMENT_PROVIDER}` +
      `${PAYMENT_PROVIDER === "stripe" && !stripe ? " [not configured]" : ""}, Pro-only)`,
  );
});
