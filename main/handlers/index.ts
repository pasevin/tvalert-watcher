/**
 * Handler Registration
 *
 * Register all IPC handlers here.
 */

import * as path from "path";
import { fileURLToPath } from "url";

import { ipcMain, logger } from "@glaze/core/backend";

import { appHandlers } from "./app.js";
import { registerAlertHandlers } from "./alerts.js";
import { registerRelayHandlers } from "./relay.js";
import { getSettingsWindow, openSettingsWindow } from "../windows/settings-window.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerHandlers(refreshTray: () => Promise<void>): void {
  logger.info("handlers", "Registering IPC handlers...");

  ipcMain.handle("app:getInfo", async (_event: unknown) => {
    return await appHandlers.getInfo();
  });

  ipcMain.handle("app:getProjectPath", async () => {
    return path.join(__dirname, "..", "..");
  });

  ipcMain.handle("window:openSettings", async (_event: unknown) => {
    await openSettingsWindow();
  });

  ipcMain.handle("window:closeSettings", async (_event: unknown) => {
    getSettingsWindow()?.close();
  });

  registerAlertHandlers(refreshTray);
  registerRelayHandlers();

  logger.info("handlers", "IPC handlers registered");
}
