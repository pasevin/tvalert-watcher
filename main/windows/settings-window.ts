import { app, BrowserWindow, logger } from "@glaze/core/backend";
import { getPreloadPath, getWindowUrl } from "./window-paths.js";

let settingsWindow: BrowserWindow | null = null;

export async function openSettingsWindow(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    logger.debug("settings", "Settings window already exists, showing it");
    settingsWindow.show();
    return;
  }

  logger.info("settings", "Creating settings window");

  // Show dock icon while settings window is open (menu-bar app pattern)
  await app.dock.show();

  settingsWindow = new BrowserWindow({
    windowKey: "settings",
    width: 540,
    height: 500,
    minWidth: 440,
    minHeight: 380,
    title: "Settings",
    show: false,
    center: true,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
    // Hide dock again when settings window is closed
    app.dock.hide().catch(() => {});
  });

  const url = await getWindowUrl("settings-window.html");
  logger.info("settings", "Loading settings URL", { url });

  await settingsWindow.loadURL(url);
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
