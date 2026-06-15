/**
 * Glaze App Preload Script
 *
 * This script runs BEFORE the main renderer code and sets up the secure bridge
 * between the renderer and the native/backend processes.
 *
 * SECURITY MODEL:
 * - This is the ONLY file that should import from '@glaze/core/preload'
 * - Renderer code should ONLY access window.glazeAPI
 * - Never expose ipcRenderer directly - only expose specific, controlled APIs
 *
 * BUILD & RUNTIME CONSTRAINTS:
 * The preload is built as a self-contained IIFE (not an ES module) because
 * WKWebView injects it via WKUserScript, which only supports classic scripts.
 * This is handled transparently by the build system — write normal imports here
 * and esbuild bundles everything into one file. Constraints to be aware of:
 * - No dynamic import() — all dependencies are resolved at build time
 * - No top-level await — wrap async code in an async function
 * - No Node.js APIs (fs, path, etc.) — WKWebView is a browser environment
 * - Keep this file thin — everything is inlined, so large deps increase injection time
 * - WKContentWorld provides separate JavaScript environments with their own
 *   globals and prototypes, so the preload world stays isolated from page code
 *
 * SECURE DEFAULTS:
 * By default, only SAFE APIs are exposed:
 * - dialog.* - Requires explicit user interaction with native UI
 * - shell.beep - Just plays a system sound (harmless)
 * - glaze.ipc - For your custom handlers (you control what's exposed)
 *
 * SENSITIVE APIs (NOT exposed by default):
 * - clipboard.* - Data theft risk via XSS
 * - shell.openExternal - Phishing/malware download risk
 * - shell.openPath - Arbitrary file execution risk
 * - file.read - Arbitrary file reading risk
 * - screen.* - Fingerprinting concern
 *
 * To add sensitive APIs for YOUR app, uncomment them below.
 * Only expose what your app actually needs!
 */

import { ipcRenderer, contextBridge, createWebUtilsAPI } from "@glaze/core/preload";

// Type imports only (safe - doesn't affect runtime)
import type {
  AskForMediaAccessType,
  DatePickerOptions,
  DatePickerResult,
  LocationPosition,
  LocationPositionOptions,
  MediaAccessType,
  OpenDialogOptions,
  OpenDialogResult,
  PermissionDiagnostic,
  PermissionStatus,
  SaveDialogOptions,
  SaveDialogResult,
  MessageBoxOptions,
  MessageBoxResult,
  NativeThemeInfo,
  MenuItemConstructorOptions,
  PopupOptions,
  PopupResult,
  SystemPreferencesAuthorizationType,
} from "@glaze/core/ipc";

// Re-export types for use in renderer code
export type {
  AskForMediaAccessType,
  LocationPosition,
  LocationPositionOptions,
  MediaAccessType,
  OpenDialogOptions,
  OpenDialogResult,
  PermissionDiagnostic,
  PermissionStatus,
  SaveDialogOptions,
  SaveDialogResult,
  MessageBoxOptions,
  MessageBoxResult,
  NativeThemeInfo,
  MenuItemConstructorOptions,
  PopupOptions,
  PopupResult,
  SystemPreferencesAuthorizationType,
};

const webUtils = createWebUtilsAPI();

/**
 * GlazeAPI - The secure API exposed to renderer code
 *
 * All IPC communication MUST go through this API.
 * Renderer code should NEVER import ipcRenderer directly.
 *
 * MINIMAL SECURE DEFAULTS - only safe APIs are exposed.
 * See comments above for how to add sensitive APIs if needed.
 */
const glazeAPI = {
  // -------------------------------------------------------------------------
  // Dialog APIs - SAFE: Requires explicit user interaction with native UI
  // -------------------------------------------------------------------------
  dialog: {
    showOpenDialog: (options?: OpenDialogOptions): Promise<OpenDialogResult> =>
      ipcRenderer.invoke("dialog:showOpenDialog", options),

    showSaveDialog: (options?: SaveDialogOptions): Promise<SaveDialogResult> =>
      ipcRenderer.invoke("dialog:showSaveDialog", options),

    showMessageBox: (options: MessageBoxOptions): Promise<MessageBoxResult> =>
      ipcRenderer.invoke("dialog:showMessageBox", options),

    showErrorBox: (title: string, content: string): Promise<void> =>
      ipcRenderer.invoke("dialog:showErrorBox", title, content),

    showDatePicker: (options: DatePickerOptions): Promise<DatePickerResult> =>
      ipcRenderer.invoke("dialog:showDatePicker", options),
  },

  // -------------------------------------------------------------------------
  // Shell APIs - Only SAFE methods exposed by default
  // -------------------------------------------------------------------------
  shell: {
    // SAFE: Just plays a system sound
    beep: (): Promise<void> => ipcRenderer.invoke("shell:beep"),

    // ⚠️ SENSITIVE - Uncomment ONLY if your app needs these:
    //
    // openPath: (path: string): Promise<string> =>
    //   ipcRenderer.invoke("shell:openPath", path),
    //
    // openExternal: (url: string): Promise<boolean> =>
    //   ipcRenderer.invoke("shell:openExternal", url),
    //
    // showItemInFolder: (fullPath: string): Promise<void> =>
    //   ipcRenderer.invoke("shell:showItemInFolder", fullPath),
    //
    // trashItem: (path: string): Promise<void> =>
    //   ipcRenderer.invoke("shell:trashItem", path),
  },

  // -------------------------------------------------------------------------
  // WebUtils APIs - webUtils module
  // -------------------------------------------------------------------------
  webUtils,

  // -------------------------------------------------------------------------
  // Clipboard APIs - ⚠️ SENSITIVE: Not exposed by default
  // Uncomment ONLY if your app needs clipboard access
  // Also add createClipboardAPI to the @glaze/core/preload import above.
  // -------------------------------------------------------------------------
  // clipboard: createClipboardAPI(ipcRenderer.invoke.bind(ipcRenderer)),

  // -------------------------------------------------------------------------
  // Native Theme APIs - For theme detection and switching
  // -------------------------------------------------------------------------
  nativeTheme: {
    getInfo: (): Promise<NativeThemeInfo> => ipcRenderer.invoke("nativeTheme:getInfo"),

    setThemeSource: (source: "system" | "light" | "dark"): Promise<boolean> =>
      ipcRenderer.invoke("nativeTheme:setThemeSource", source),

    getShouldUseDarkColors: (): Promise<boolean> =>
      ipcRenderer.invoke("nativeTheme:getShouldUseDarkColors"),

    getThemeSource: (): Promise<"system" | "light" | "dark"> =>
      ipcRenderer.invoke("nativeTheme:getThemeSource"),
  },

  // -------------------------------------------------------------------------
  // Minimal permissions APIs used by the template examples
  // -------------------------------------------------------------------------
  systemPreferences: {
    getMediaAccessStatus: (mediaType: MediaAccessType): Promise<PermissionStatus> =>
      ipcRenderer.invoke("systemPreferences:getMediaAccessStatus", mediaType),

    askForMediaAccess: (mediaType: AskForMediaAccessType): Promise<boolean> =>
      ipcRenderer.invoke("systemPreferences:askForMediaAccess", mediaType),

    requestScreenCaptureAccess: (): Promise<boolean> =>
      ipcRenderer.invoke("systemPreferences:requestScreenCaptureAccess"),

    getAuthorizationStatus: (type: SystemPreferencesAuthorizationType): Promise<PermissionStatus> =>
      ipcRenderer.invoke("systemPreferences:getAuthorizationStatus", type),
  },

  location: {
    getCurrentPosition: (options?: LocationPositionOptions): Promise<LocationPosition> =>
      ipcRenderer.invoke("location:getCurrentPosition", options),
  },

  permissions: {
    getDiagnostics: (): Promise<PermissionDiagnostic[]> =>
      ipcRenderer.invoke("glaze:permissions:getDiagnostics"),
  },

  // -------------------------------------------------------------------------
  // Menu APIs - For native dropdown/context menus
  // -------------------------------------------------------------------------
  Menu: {
    popup: (options: PopupOptions): Promise<PopupResult> =>
      ipcRenderer.invoke("Menu:popup", options),

    setApplicationMenu: (template: MenuItemConstructorOptions[] | null): Promise<void> =>
      ipcRenderer.invoke("Menu:setApplicationMenu", template),
  },

  // -------------------------------------------------------------------------
  // Glaze IPC - SAFE: For your custom backend handlers
  // You control what handlers exist, so you control what's exposed
  // -------------------------------------------------------------------------
  glaze: {
    ipc: {
      /**
       * Invoke a backend handler and wait for the result
       * Use for custom handlers registered with ipcMain.handle()
       */
      invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
        ipcRenderer.invoke(channel, ...args),

      /**
       * Subscribe to notifications from the backend
       * Returns an unsubscribe function
       */
      onNotification: (channel: string, callback: (params: unknown) => void): (() => void) =>
        ipcRenderer.onNotification(channel, callback),

      /**
       * Check if connected to the backend
       */
      isConnected: (): boolean => ipcRenderer.isConnected(),

      /**
       * Wait for the IPC connection to be ready.
       * The connection is automatically established on first IPC call, but
       * you can use this to explicitly wait if needed (e.g., to show a loading state).
       */
      waitForReady: (): Promise<void> => ipcRenderer.waitForReady(),

      /**
       * Disconnect from the backend
       */
      disconnect: (): void => ipcRenderer.disconnect(),
    },
  },

  // -------------------------------------------------------------------------
  // Build metadata - exposed from preload world where env-var scripts inject
  // -------------------------------------------------------------------------
  buildFlavor: (window as any).buildFlavor ?? "Production",
};

// Expose the API to the renderer via contextBridge
contextBridge.exposeInMainWorld("glazeAPI", glazeAPI);

// Export type for TypeScript
export type GlazeAPI = typeof glazeAPI;
