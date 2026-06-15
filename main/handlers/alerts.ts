import { ipcMain, logger } from "@glaze/core/backend";

import { alertStore } from "../services/alert-store.js";
import { settingsStore } from "../services/settings-store.js";
import { webhookServer } from "../services/webhook-server.js";

function isStringId(v: unknown): v is { id: string } {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).id === "string";
}

function isPartialSettings(v: unknown): v is Partial<{ port: number; notifications: boolean; sound: boolean; badge: boolean }> {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if ("port" in obj && typeof obj.port !== "number") return false;
  if ("notifications" in obj && typeof obj.notifications !== "boolean") return false;
  if ("sound" in obj && typeof obj.sound !== "boolean") return false;
  if ("badge" in obj && typeof obj.badge !== "boolean") return false;
  return true;
}

function isPortPayload(v: unknown): v is { port: number } {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).port === "number";
}

export function registerAlertHandlers(refreshTray: () => Promise<void>): void {
  // alerts:list
  ipcMain.handle("alerts:list", async () => {
    try {
      return await alertStore.list();
    } catch (err) {
      logger.error("alerts-handler", "alerts:list failed", err);
      throw err;
    }
  });

  // alerts:markAllRead
  ipcMain.handle("alerts:markAllRead", async (_event: unknown) => {
    try {
      await alertStore.markAllRead();
      const unreadCount = await alertStore.unreadCount();
      await refreshTray();
      ipcMain.broadcast("alerts:changed", { unreadCount });
      return { ok: true as const };
    } catch (err) {
      logger.error("alerts-handler", "alerts:markAllRead failed", err);
      throw err;
    }
  });

  // alerts:delete
  ipcMain.handle("alerts:delete", async (_event: unknown, params: unknown) => {
    if (!isStringId(params)) {
      throw new Error("alerts:delete requires { id: string }");
    }
    try {
      await alertStore.delete(params.id);
      const unreadCount = await alertStore.unreadCount();
      await refreshTray();
      ipcMain.broadcast("alerts:changed", { unreadCount });
      return { ok: true as const };
    } catch (err) {
      logger.error("alerts-handler", "alerts:delete failed", { id: params.id, err });
      throw err;
    }
  });

  // alerts:clear
  ipcMain.handle("alerts:clear", async () => {
    try {
      await alertStore.clear();
      const unreadCount = await alertStore.unreadCount();
      await refreshTray();
      ipcMain.broadcast("alerts:changed", { unreadCount });
      return { ok: true as const };
    } catch (err) {
      logger.error("alerts-handler", "alerts:clear failed", err);
      throw err;
    }
  });

  // server:getStatus
  ipcMain.handle("server:getStatus", () => {
    return webhookServer.getStatus();
  });

  // server:setPort
  ipcMain.handle("server:setPort", async (_event: unknown, params: unknown) => {
    if (!isPortPayload(params)) {
      throw new Error("server:setPort requires { port: number }");
    }
    const { port } = params;
    if (port < 1 || port > 65535 || !Number.isInteger(port)) {
      throw new Error(`Invalid port: ${port}. Must be an integer between 1 and 65535.`);
    }
    try {
      await webhookServer.restart(port);
      await settingsStore.set({ port });
      const status = webhookServer.getStatus();
      ipcMain.broadcast("server:status-changed", status);
      return status;
    } catch (err) {
      logger.error("alerts-handler", "server:setPort failed", { port, err });
      const status = webhookServer.getStatus();
      ipcMain.broadcast("server:status-changed", status);
      return status;
    }
  });

  // settings:get
  ipcMain.handle("settings:get", async () => {
    try {
      return await settingsStore.get();
    } catch (err) {
      logger.error("alerts-handler", "settings:get failed", err);
      throw err;
    }
  });

  // settings:set
  ipcMain.handle("settings:set", async (_event: unknown, params: unknown) => {
    if (!isPartialSettings(params)) {
      throw new Error("settings:set requires a valid Partial<Settings> object");
    }
    try {
      const updated = await settingsStore.set(params);
      await refreshTray();
      ipcMain.broadcast("settings:changed", updated);
      return updated;
    } catch (err) {
      logger.error("alerts-handler", "settings:set failed", err);
      throw err;
    }
  });
}
