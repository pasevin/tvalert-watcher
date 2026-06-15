// Main process entry point - Node.js backend for Glaze app
//
// Menu-bar (tray popover) app — no dock icon, no main window on launch.
// The glaze CLI runtime automatically handles all framework wiring (IPC server,
// native bridge, lifecycle, signal handlers) before this file runs.

import { app, Tray, Menu, shell, Notification, ipcMain, logger, initDevToolsButtonState } from "@glaze/core/backend";

import { registerHandlers } from "./handlers/index.js";
import { openSettingsWindow } from "./windows/settings-window.js";
import { alertStore } from "./services/alert-store.js";
import { settingsStore } from "./services/settings-store.js";
import { webhookServer } from "./services/webhook-server.js";
import { relayClient } from "./services/relay-client.js";
import { setUpdateBadgeCallback, extractSymbol } from "./services/alert-dispatch.js";
import { getLogoPath, initLogoCache, setOnLogoReady } from "./services/logo-cache.js";

// ── State ─────────────────────────────────────────────────────────────
let tray: Tray | null = null;

type MenuTemplate = Parameters<typeof Menu.buildFromTemplate>[0];

// ── Helpers ───────────────────────────────────────────────────────────
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

// ── Native tray menu ──────────────────────────────────────────────────
async function buildTrayMenu(): Promise<ReturnType<typeof Menu.buildFromTemplate>> {
  const alerts = await alertStore.list();
  const status = webhookServer.getStatus();
  const unread = alerts.filter((a) => !a.read).length;

  const template: MenuTemplate = [];

  // Account + cloud relay status (primary, friendly path)
  const relay = relayClient.getStatus();
  const auth = relayClient.getAuthStatus();
  if (auth.authRequired === false) {
    // Self-hosted relay — no account needed.
    template.push({
      label: relay.connected ? "Self-hosted relay connected" : "Self-hosted relay connecting…",
      icon: relay.connected ? "cloud.fill" : "cloud",
      enabled: false,
    });
  } else if (!auth.signedIn) {
    template.push({
      label: auth.pending ? "Check your email to finish sign-in" : "Not signed in",
      icon: "person.crop.circle.badge.exclamationmark",
      enabled: false,
    });
    template.push({
      label: "Sign in…",
      icon: "person.crop.circle",
      click: async () => {
        await openSettingsWindow();
      },
    });
  } else {
    template.push({
      label: `${auth.email ?? "Account"}  ·  ${auth.pro ? "Pro" : "Free"}`,
      icon: "person.crop.circle.fill",
      enabled: false,
    });
    if (relay.enabled) {
      template.push({
        label: relay.connected ? "Cloud relay connected" : "Cloud relay connecting…",
        icon: relay.connected ? "cloud.fill" : "cloud",
        enabled: false,
      });
    }
  }

  // Local server status header
  template.push({
    label: status.running ? `Local server on port ${status.port}` : "Local server stopped",
    icon: status.running ? "dot.radiowaves.left.and.right" : "exclamationmark.triangle.fill",
    enabled: false,
  });
  if (status.error) {
    template.push({ label: truncate(status.error, 48), enabled: false });
  }
  template.push({ type: "separator" });

  // Recent alerts
  if (alerts.length === 0) {
    template.push({ label: "No alerts yet", enabled: false });
  } else {
    template.push({
      label: unread > 0 ? `Recent Alerts · ${unread} new` : "Recent Alerts",
      enabled: false,
    });
    for (const alert of alerts.slice(0, 15)) {
      const symbol = alert.ticker ?? extractSymbol(alert.message) ?? extractSymbol(alert.raw);
      const primary = alert.ticker ? alert.ticker : truncate(alert.message, 44);
      const detail: string[] = [];
      if (alert.ticker) detail.push(truncate(alert.message, 44));
      if (alert.price) detail.push(`$${alert.price}`);
      detail.push(relativeTime(alert.receivedAt));
      // Asset logos are a Pro perk — free/non-Pro accounts get the bell.
      const logo = symbol && auth.pro ? getLogoPath(symbol) : undefined;
      // Trailing ↗ marks alerts that open a TradingView chart (native menus have
      // no right-aligned accessory icon, so a glyph on the label is the cue).
      template.push({
        label: symbol ? `${primary}  ↗` : primary,
        sublabel: detail.join("  ·  "),
        icon: logo ?? (alert.read ? "bell" : "circlebadge.fill"),
        click: async () => {
          // Open the TradingView chart for this pair. Prefer the explicit ticker,
          // otherwise try to recover a symbol from the alert text.
          const symbol = alert.ticker ?? extractSymbol(alert.message) ?? extractSymbol(alert.raw);
          logger.info("main", "[alert:click]", { id: alert.id, ticker: alert.ticker ?? null, resolved: symbol ?? null });
          if (symbol) {
            const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol.trim())}`;
            try {
              await shell.openExternal(url);
              logger.info("main", "[alert:click] opened chart", { url });
            } catch (err) {
              logger.error("main", "[alert:click] openExternal failed", { url, err });
            }
          } else {
            // No symbol to open — give feedback instead of doing nothing.
            try {
              new Notification({
                title: "No symbol in this alert",
                body: "Add the ticker (e.g. {{ticker}}) to your TradingView alert to open its chart.",
              }).show();
            } catch {
              // ignore
            }
          }
          await alertStore.markAllRead();
          ipcMain.broadcast("alerts:changed", { unreadCount: 0 });
          await refreshTray();
        },
      });
    }
  }

  template.push({ type: "separator" });
  if (unread > 0) {
    template.push({
      label: "Mark All as Read",
      icon: "checkmark.circle",
      click: async () => {
        await alertStore.markAllRead();
        ipcMain.broadcast("alerts:changed", { unreadCount: 0 });
        await refreshTray();
      },
    });
  }
  if (alerts.length > 0) {
    template.push({
      label: "Clear All Alerts",
      icon: "trash",
      click: async () => {
        await alertStore.clear();
        ipcMain.broadcast("alerts:changed", { unreadCount: 0 });
        await refreshTray();
      },
    });
  }
  template.push({ type: "separator" });
  template.push({
    label: "Settings…",
    icon: "gearshape",
    accelerator: "Command+,",
    click: async () => {
      await openSettingsWindow();
    },
  });
  template.push({ label: "Quit TradingView Alerts", icon: "power", role: "quit" });

  return Menu.buildFromTemplate(template);
}

// ── Tray refresh (badge + menu) ───────────────────────────────────────
async function refreshTray(): Promise<void> {
  if (!tray || tray.isDestroyed()) return;
  try {
    const settings = await settingsStore.get();
    const unread = await alertStore.unreadCount();
    const hasUnread = settings.badge && unread > 0;
    tray.setTitle(hasUnread ? String(unread) : "");
    tray.setImage(hasUnread ? "bell.badge.fill" : "bell");
    tray.setContextMenu(await buildTrayMenu());
  } catch (err) {
    logger.error("main", "Failed to refresh tray", err);
  }
}

// ── Tray setup ────────────────────────────────────────────────────────
async function setupTray(): Promise<void> {
  tray = new Tray("bell");
  tray.setToolTip("TradingView Alerts");
  // Setting a context menu makes a left-click open the menu natively.
  await refreshTray();
}

// ── Application menu ──────────────────────────────────────────────────
async function setupApplicationMenu(): Promise<void> {
  await initDevToolsButtonState();
  const menu = Menu.buildFromTemplate([
    {
      label: "App",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          icon: "gearshape",
          accelerator: "Command+,",
          click: async () => await openSettingsWindow(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Lifecycle events ──────────────────────────────────────────────────
app.on("window-all-closed", () => {
  // Menu-bar app — do NOT quit when all windows are closed
});

app.on("activate", async () => {
  // Keep dock hidden on re-activate (menu-bar app pattern)
  await app.dock.hide();
});

app.on("before-quit", () => {
  logger.info("main", "App before-quit, cleaning up...");
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  webhookServer.stop().catch((err) => {
    logger.error("main", "Failed to stop webhook server during quit", err);
  });
  relayClient.stop().catch((err) => {
    logger.error("main", "Failed to stop relay client during quit", err);
  });
});

// ── IPC: refresh tray when a webhook arrives ──────────────────────────
setUpdateBadgeCallback(() => {
  refreshTray().catch((err) => {
    logger.error("main", "Tray refresh failed from webhook callback", err);
  });
});

// ── Register handlers ─────────────────────────────────────────────────
registerHandlers(refreshTray);

// ── App ready ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  logger.info("main", "App ready — initializing menu-bar app");

  // Hide dock immediately (LSUIElement pattern)
  await app.dock.hide();

  await setupApplicationMenu();

  // Asset logos for alert menu icons (cached locally; rebuild tray when one lands).
  await initLogoCache();
  setOnLogoReady(() => {
    refreshTray().catch((err) => logger.error("main", "Tray refresh after logo ready failed", err));
  });

  await setupTray();

  // Start local webhook server using persisted port
  const settings = await settingsStore.get();
  try {
    await webhookServer.start(settings.port);
    ipcMain.broadcast("server:status-changed", webhookServer.getStatus());
  } catch (err) {
    logger.error("main", "Webhook server failed to start on initial launch", err);
    ipcMain.broadcast("server:status-changed", webhookServer.getStatus());
  }

  // Connect to the cloud relay (primary, zero-setup path)
  relayClient.onStatusChange((relayStatus) => {
    ipcMain.broadcast("relay:status-changed", relayStatus);
    refreshTray().catch((err) => logger.error("main", "Tray refresh after relay status failed", err));
  });
  relayClient.onAuthChange((authStatus) => {
    ipcMain.broadcast("auth:changed", authStatus);
    refreshTray().catch((err) => logger.error("main", "Tray refresh after auth change failed", err));
  });
  relayClient.init().catch((err) => {
    logger.error("main", "Relay client failed to initialize", err);
  });
});
