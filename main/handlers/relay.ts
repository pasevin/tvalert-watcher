import { ipcMain, logger } from "@glaze/core/backend";

import { relayClient } from "../services/relay-client.js";

function isEnabledPayload(v: unknown): v is { enabled: boolean } {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).enabled === "boolean";
}

function isUrlPayload(v: unknown): v is { url: string } {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).url === "string";
}

function isEmailPayload(v: unknown): v is { email: string } {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).email === "string";
}

export function registerRelayHandlers(): void {
  ipcMain.handle("relay:getStatus", () => relayClient.getStatus());

  ipcMain.handle("relay:setEnabled", async (_event: unknown, params: unknown) => {
    if (!isEnabledPayload(params)) {
      throw new Error("relay:setEnabled requires { enabled: boolean }");
    }
    try {
      return await relayClient.setEnabled(params.enabled);
    } catch (err) {
      logger.error("relay-handler", "relay:setEnabled failed", err);
      throw err;
    }
  });

  ipcMain.handle("relay:setBaseUrl", async (_event: unknown, params: unknown) => {
    if (!isUrlPayload(params)) {
      throw new Error("relay:setBaseUrl requires { url: string }");
    }
    try {
      // Validate it parses as an http(s) URL before applying.
      const parsed = new URL(params.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Relay URL must start with http:// or https://");
      }
      return await relayClient.setBaseUrl(params.url);
    } catch (err) {
      logger.error("relay-handler", "relay:setBaseUrl failed", { url: params.url, err });
      throw err;
    }
  });

  // ── Account (magic-link auth) ────────────────────────────────────────────────
  ipcMain.handle("auth:status", () => relayClient.getAuthStatus());

  ipcMain.handle("auth:requestLink", async (_event: unknown, params: unknown) => {
    if (!isEmailPayload(params)) {
      throw new Error("auth:requestLink requires { email: string }");
    }
    try {
      await relayClient.requestLink(params.email);
      return { ok: true as const };
    } catch (err) {
      logger.error("relay-handler", "auth:requestLink failed", err);
      throw err;
    }
  });

  ipcMain.handle("auth:cancel", () => {
    relayClient.cancel();
    return relayClient.getAuthStatus();
  });

  ipcMain.handle("auth:signOut", async () => {
    try {
      await relayClient.signOut();
      return relayClient.getAuthStatus();
    } catch (err) {
      logger.error("relay-handler", "auth:signOut failed", err);
      throw err;
    }
  });

  // ── Billing ──────────────────────────────────────────────────────────────────
  ipcMain.handle("billing:openCheckout", async (_event: unknown, params: unknown) => {
    const plan =
      typeof params === "object" && params !== null && (params as Record<string, unknown>).plan === "yearly"
        ? "yearly"
        : "monthly";
    try {
      await relayClient.openCheckout(plan);
      return { ok: true as const };
    } catch (err) {
      logger.error("relay-handler", "billing:openCheckout failed", err);
      throw err;
    }
  });

  ipcMain.handle("billing:openPortal", async () => {
    try {
      await relayClient.openPortal();
      return { ok: true as const };
    } catch (err) {
      logger.error("relay-handler", "billing:openPortal failed", err);
      throw err;
    }
  });
}
