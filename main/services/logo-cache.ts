// Asset logo cache for alert menu icons (crypto + stocks).
//
// Given a ticker, tries logo sources in order — crypto-icons CDN, then a
// stock-logo CDN — downloads the first hit, resizes to menu size with macOS
// `sips`, and caches under <userData>/logos/<key>.png. getLogoPath() is
// synchronous (used while building the native menu): returns a cached path, or
// undefined and kicks off a background download; the onReady callback rebuilds
// the tray when a logo lands. Forex/unknown symbols fall back (bell).

import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { app, logger } from "@glaze/core/backend";

const execFileP = promisify(execFile);

// Crypto quote suffixes to strip from a pair to get the base coin.
const QUOTES = ["USDT", "USDC", "BUSD", "USD", "PERP", "EUR", "GBP", "JPY", "BTC", "ETH"];
const MAX_BYTES = 1024 * 1024;
const MIN_BYTES = 200; // reject empty/placeholder responses

// Ordered logo sources. Crypto first (pairs resolve to a coin), then stocks.
function candidateUrls(meta: { coin: string; stock: string }): string[] {
  return [
    `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/128/color/${meta.coin}.png`,
    `https://financialmodelingprep.com/image-stock/${meta.stock}.png`,
  ];
}

let cacheDir: string | null = null;
// key -> local path (available) | null (known unavailable this session)
const memo = new Map<string, string | null>();
const inflight = new Set<string>();
let onReady: (() => void) | null = null;

export function setOnLogoReady(cb: () => void): void {
  onReady = cb;
}

interface SymbolMeta {
  key: string; // cache filename + memo key (e.g. "btcusdt", "aapl")
  coin: string; // crypto base for the crypto CDN (e.g. "btc")
  stock: string; // uppercased symbol for the stock CDN (e.g. "AAPL")
}

function normalize(ticker: string | undefined): SymbolMeta | null {
  if (!ticker) return null;
  const afterExchange = ticker.includes(":") ? (ticker.split(":").pop() ?? "") : ticker;
  const sym = afterExchange.toUpperCase().replace(/\.P$/, "").replace(/[^A-Z0-9]/g, "");
  if (!sym || sym.length > 15) return null;
  let coin = sym;
  for (const q of QUOTES) {
    if (coin.length > q.length && coin.endsWith(q)) {
      coin = coin.slice(0, -q.length);
      break;
    }
  }
  return { key: sym.toLowerCase(), coin: coin.toLowerCase(), stock: sym };
}

async function ensureDir(): Promise<string> {
  if (!cacheDir) {
    const userData = await app.getPath("userData");
    cacheDir = path.join(userData, "logos");
    await fs.mkdir(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/** Populate the in-memory map from already-cached files (call once at startup). */
export async function initLogoCache(): Promise<void> {
  try {
    const dir = await ensureDir();
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (f.endsWith(".png")) memo.set(f.replace(/\.png$/, ""), path.join(dir, f));
    }
  } catch (err) {
    logger.error("logo-cache", "init scan failed", err);
  }
}

/** Synchronous: cached logo path, or undefined (and trigger a background fetch). */
export function getLogoPath(ticker: string | undefined): string | undefined {
  const meta = normalize(ticker);
  if (!meta) return undefined;
  if (memo.has(meta.key)) return memo.get(meta.key) ?? undefined;
  void download(meta);
  return undefined;
}

async function download(meta: SymbolMeta): Promise<void> {
  if (inflight.has(meta.key)) return;
  inflight.add(meta.key);
  try {
    const dir = await ensureDir();
    const dst = path.join(dir, `${meta.key}.png`);
    let buf: Buffer | null = null;
    let usedSource: string | null = null;

    for (const url of candidateUrls(meta)) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length >= MIN_BYTES && data.length <= MAX_BYTES) {
          buf = data;
          usedSource = url;
          break;
        }
      } catch {
        // try next source
      }
    }

    if (!buf) {
      memo.set(meta.key, null);
      return;
    }

    await fs.writeFile(dst, buf);
    // Resize so the larger side is 36px (~18pt @2x), preserving aspect ratio.
    try {
      await execFileP("/usr/bin/sips", ["-Z", "36", dst, "--out", dst], { timeout: 5000 });
    } catch {
      // sips unavailable — keep full-size image rather than failing.
    }
    memo.set(meta.key, dst);
    logger.info("logo-cache", "[logo:cached]", { key: meta.key, source: usedSource });
    onReady?.();
  } catch (err) {
    memo.set(meta.key, null);
    logger.error("logo-cache", "download failed", { key: meta.key, err });
  } finally {
    inflight.delete(meta.key);
  }
}
