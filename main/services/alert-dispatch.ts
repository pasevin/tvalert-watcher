// Shared alert pipeline used by both the local webhook server and the cloud
// relay client: parse a raw payload, persist it, and fire notification / sound /
// badge / broadcast. Keeping this in one place ensures both sources behave
// identically.

import * as crypto from "crypto";

import { Notification, shell, ipcMain, logger } from "@glaze/core/backend";

import { alertStore, type Alert } from "./alert-store.js";
import { settingsStore } from "./settings-store.js";

export type AlertSource = "local" | "cloud";

// Tray badge update callback — injected from main/index.ts to avoid circular deps.
let updateBadgeCallback: (() => void) | null = null;

export function setUpdateBadgeCallback(cb: () => void): void {
  updateBadgeCallback = cb;
}

/**
 * Best-effort extraction of a TradingView symbol from arbitrary alert text,
 * for opening the chart when there's no explicit `ticker` field.
 * Matches `EXCHANGE:SYMBOL` (e.g. BINANCE:BTCUSDT, NASDAQ:AAPL) or a crypto/FX
 * pair (e.g. BTCUSDT, ETHUSD, EURUSD), or a message that is a single ticker token.
 */
export function extractSymbol(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  const exchange = t.match(/\b[A-Z]{2,8}:[A-Z0-9.!]{1,15}\b/);
  if (exchange) return exchange[0];
  const pair = t.match(/\b[A-Z]{2,6}(?:USDT|USDC|BUSD|USD|PERP|BTC|ETH|EUR|GBP|JPY)\b/);
  if (pair) return pair[0];
  if (/^[A-Z][A-Z0-9.]{1,11}$/.test(t)) return t;
  return undefined;
}

/** Parse a raw webhook body into structured alert fields (JSON or plain text). */
export function parseAlert(raw: string): { ticker?: string; message: string; price?: string } {
  const trimmed = raw.trim();
  let ticker: string | undefined;
  let message = trimmed;
  let price: string | undefined;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.ticker === "string") ticker = parsed.ticker;
    else if (typeof parsed.symbol === "string") ticker = parsed.symbol;
    if (typeof parsed.message === "string") message = parsed.message;
    else if (typeof parsed.text === "string") message = parsed.text;
    if (typeof parsed.price === "string") price = parsed.price;
    else if (typeof parsed.price === "number") price = String(parsed.price);
  } catch {
    // Not JSON — treat the raw body as the message.
    message = trimmed;
  }

  // No explicit ticker — try to recover a symbol from the message text.
  if (!ticker) ticker = extractSymbol(message) ?? undefined;

  return { ticker, message, price };
}

/** Full pipeline: store the alert and trigger all enabled notifications. */
export async function dispatchAlert(raw: string, source: AlertSource): Promise<void> {
  const trimmed = raw.trim();
  const { ticker, message, price } = parseAlert(trimmed);

  const alert: Alert = {
    id: crypto.randomUUID(),
    receivedAt: Date.now(),
    ticker,
    message,
    price,
    raw: trimmed,
    read: false,
  };

  console.log("[alert:received]", { source, id: alert.id, ticker, message, price });
  logger.info("alert-dispatch", "[alert:received]", { source, id: alert.id, ticker, message, price });

  await alertStore.add(alert);
  const unreadCount = await alertStore.unreadCount();

  const settings = await settingsStore.get();

  if (settings.notifications) {
    try {
      const title = ticker ? `Alert: ${ticker}` : "TradingView Alert";
      new Notification({ title, body: message }).show();
    } catch (err) {
      logger.error("alert-dispatch", "Failed to show notification", err);
    }
  }

  if (settings.sound) {
    try {
      shell.beep();
    } catch (err) {
      logger.error("alert-dispatch", "Failed to beep", err);
    }
  }

  if (updateBadgeCallback) {
    updateBadgeCallback();
  }

  ipcMain.broadcast("alerts:new", { alert, unreadCount });
}
