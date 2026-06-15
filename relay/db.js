// Persistence layer for the relay (SQLite via better-sqlite3).
//
// Stores accounts, account-bound webhook tokens, app sessions, pending
// magic-links, and per-day usage counters. The DB file lives on a persistent
// volume (DB_PATH, default /data/relay.db on Fly) so tokens survive restarts.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "/data/relay.db";

// Ensure the directory exists (e.g. /data on first boot, or ./ locally).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    pro         INTEGER NOT NULL DEFAULT 0,
    portal_url  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_tokens (
    token       TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_token TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
  CREATE TABLE IF NOT EXISTS magic_links (
    link_token  TEXT PRIMARY KEY,
    poll_token  TEXT UNIQUE NOT NULL,
    email       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed    INTEGER NOT NULL DEFAULT 0,
    session_token TEXT
  );
  CREATE TABLE IF NOT EXISTS usage (
    account_id  TEXT NOT NULL,
    day         TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day)
  );
  CREATE TABLE IF NOT EXISTS queued_alerts (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_queued_account ON queued_alerts(account_id, created_at);
`);

// Migrations for DBs created before the billing columns existed.
const accountCols = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
if (!accountCols.includes("portal_url")) {
  db.exec("ALTER TABLE accounts ADD COLUMN portal_url TEXT");
}
if (!accountCols.includes("stripe_customer")) {
  db.exec("ALTER TABLE accounts ADD COLUMN stripe_customer TEXT");
}

const id = () => crypto.randomBytes(9).toString("base64url");
const today = () => new Date().toISOString().slice(0, 10);

// ── Accounts ─────────────────────────────────────────────────────────────────
export function upsertAccount(email) {
  const normalized = email.trim().toLowerCase();
  const existing = db.prepare("SELECT * FROM accounts WHERE email = ?").get(normalized);
  if (existing) return existing;
  const account = { id: id(), email: normalized, pro: 0, created_at: Date.now() };
  db.prepare("INSERT INTO accounts (id, email, pro, created_at) VALUES (@id, @email, @pro, @created_at)").run(account);
  return account;
}

export function getAccountById(accountId) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
}

// Single implicit account used when the relay runs with auth disabled
// (self-host mode). Always Pro / unlimited.
export function getOrCreateSelfHostAccount() {
  const account = upsertAccount("selfhost@localhost");
  if (!account.pro) {
    db.prepare("UPDATE accounts SET pro = 1 WHERE id = ?").run(account.id);
  }
  return getAccountById(account.id);
}

export function setPro(email, pro) {
  const normalized = email.trim().toLowerCase();
  const account = upsertAccount(normalized);
  db.prepare("UPDATE accounts SET pro = ? WHERE id = ?").run(pro ? 1 : 0, account.id);
  return getAccountById(account.id);
}

// Update Pro state from a billing event, optionally storing the customer
// portal URL. Returns the updated account (so callers can push entitlement).
export function setProByEmail(email, pro, portalUrl) {
  const normalized = email.trim().toLowerCase();
  const account = upsertAccount(normalized);
  if (portalUrl) {
    db.prepare("UPDATE accounts SET pro = ?, portal_url = ? WHERE id = ?").run(pro ? 1 : 0, portalUrl, account.id);
  } else {
    db.prepare("UPDATE accounts SET pro = ? WHERE id = ?").run(pro ? 1 : 0, account.id);
  }
  return getAccountById(account.id);
}

// The account's existing webhook token, if any (used to push entitlement
// updates to a connected app without creating a token).
export function getTokenForAccount(accountId) {
  const row = db.prepare("SELECT token FROM webhook_tokens WHERE account_id = ?").get(accountId);
  return row ? row.token : null;
}

// Stripe customer mapping (so subscription.* webhook events resolve to an account).
export function setStripeCustomer(accountId, customerId) {
  db.prepare("UPDATE accounts SET stripe_customer = ? WHERE id = ?").run(customerId, accountId);
}

export function getAccountByStripeCustomer(customerId) {
  return db.prepare("SELECT * FROM accounts WHERE stripe_customer = ?").get(customerId);
}

// ── Durable offline alert queue (Pro perk) ─────────────────────────────────────
const MAX_QUEUE_PER_ACCOUNT = 200;

export function enqueueAlert(accountId, payload) {
  db.prepare(
    "INSERT INTO queued_alerts (id, account_id, payload, created_at) VALUES (?, ?, ?, ?)",
  ).run(id(), accountId, payload, Date.now());
  // Cap per account: keep only the newest MAX_QUEUE_PER_ACCOUNT.
  db.prepare(
    `DELETE FROM queued_alerts WHERE account_id = ? AND id NOT IN (
       SELECT id FROM queued_alerts WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(accountId, accountId, MAX_QUEUE_PER_ACCOUNT);
}

/** Return all queued alert payloads (oldest first) for an account and clear them. */
export function drainQueuedAlerts(accountId) {
  const rows = db
    .prepare("SELECT payload FROM queued_alerts WHERE account_id = ? ORDER BY created_at ASC")
    .all(accountId);
  if (rows.length) {
    db.prepare("DELETE FROM queued_alerts WHERE account_id = ?").run(accountId);
  }
  return rows.map((r) => r.payload);
}

export function pruneQueuedAlerts(ttlMs) {
  db.prepare("DELETE FROM queued_alerts WHERE created_at < ?").run(Date.now() - ttlMs);
}

// ── Sessions ─────────────────────────────────────────────────────────────────
export function createSession(accountId) {
  const sessionToken = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sessions (session_token, account_id, created_at) VALUES (?, ?, ?)").run(
    sessionToken,
    accountId,
    Date.now(),
  );
  return sessionToken;
}

export function getAccountBySession(sessionToken) {
  if (!sessionToken) return null;
  return db
    .prepare(
      "SELECT a.* FROM accounts a JOIN sessions s ON s.account_id = a.id WHERE s.session_token = ?",
    )
    .get(sessionToken);
}

export function deleteSession(sessionToken) {
  db.prepare("DELETE FROM sessions WHERE session_token = ?").run(sessionToken);
}

// ── Webhook tokens (one stable token per account) ──────────────────────────────
export function getOrCreateWebhookToken(accountId) {
  const existing = db.prepare("SELECT token FROM webhook_tokens WHERE account_id = ?").get(accountId);
  if (existing) return existing.token;
  const token = id();
  db.prepare("INSERT INTO webhook_tokens (token, account_id, created_at) VALUES (?, ?, ?)").run(
    token,
    accountId,
    Date.now(),
  );
  return token;
}

export function getAccountByToken(token) {
  return db
    .prepare(
      "SELECT a.* FROM accounts a JOIN webhook_tokens t ON t.account_id = a.id WHERE t.token = ?",
    )
    .get(token);
}

// ── Magic links ────────────────────────────────────────────────────────────────
export function createMagicLink(email, ttlMs) {
  const linkToken = crypto.randomBytes(24).toString("base64url");
  const pollToken = crypto.randomBytes(18).toString("base64url");
  db.prepare(
    "INSERT INTO magic_links (link_token, poll_token, email, expires_at, consumed) VALUES (?, ?, ?, ?, 0)",
  ).run(linkToken, pollToken, email.trim().toLowerCase(), Date.now() + ttlMs);
  return { linkToken, pollToken };
}

export function consumeMagicLink(linkToken) {
  const row = db.prepare("SELECT * FROM magic_links WHERE link_token = ?").get(linkToken);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.consumed) return { ok: false, reason: "used" };
  if (row.expires_at < Date.now()) return { ok: false, reason: "expired" };

  const account = upsertAccount(row.email);
  const sessionToken = createSession(account.id);
  db.prepare("UPDATE magic_links SET consumed = 1, session_token = ? WHERE link_token = ?").run(
    sessionToken,
    linkToken,
  );
  return { ok: true, email: row.email };
}

export function pollMagicLink(pollToken) {
  const row = db.prepare("SELECT * FROM magic_links WHERE poll_token = ?").get(pollToken);
  if (!row) return { status: "not_found" };
  if (!row.consumed || !row.session_token) {
    if (row.expires_at < Date.now()) return { status: "expired" };
    return { status: "pending" };
  }
  const account = upsertAccount(row.email);
  return {
    status: "ok",
    sessionToken: row.session_token,
    email: account.email,
    pro: !!account.pro,
  };
}

// ── Usage (per account per day) ─────────────────────────────────────────────────
export function incrementUsage(accountId) {
  const day = today();
  db.prepare(
    `INSERT INTO usage (account_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(account_id, day) DO UPDATE SET count = count + 1`,
  ).run(accountId, day);
  return getUsage(accountId);
}

export function getUsage(accountId) {
  const row = db.prepare("SELECT count FROM usage WHERE account_id = ? AND day = ?").get(accountId, today());
  return row ? row.count : 0;
}

export default db;
