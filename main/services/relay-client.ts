// Cloud relay client (Phase 2).
//
// Handles magic-link sign-in (poll-based, no deep links), an account-bound
// webhook token, and a reconnecting WebSocket to the hosted relay. Cloud mode
// requires sign-in; the local webhook server remains the no-account fallback.
// Uses Node's built-in global `fetch` and `WebSocket` (Node 21+).

import { Notification, shell, logger } from "@glaze/core/backend";

import { settingsStore } from "./settings-store.js";
import { dispatchAlert } from "./alert-dispatch.js";

export interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  relayBaseUrl: string;
  token: string | null;
  hookUrl: string | null;
  error?: string;
}

export interface AuthStatus {
  signedIn: boolean;
  email: string | null;
  pro: boolean;
  portalUrl: string | null;
  hookUrl: string | null;
  pending: boolean;
  pendingEmail: string | null;
  authRequired: boolean;
  error?: string;
}

const MAX_RECONNECT_DELAY = 30000;
const POLL_INTERVAL_MS = 3000;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function toWsUrl(base: string, token: string): string {
  const u = new URL(trimSlash(base));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = `?token=${encodeURIComponent(token)}`;
  return u.toString();
}

class RelayClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private baseUrl = "https://alert-watcher-relay.fly.dev";
  private enabled = true;

  // Account state
  private sessionToken: string | null = null;
  private email: string | null = null;
  private pro = false;
  private portalUrl: string | null = null;
  private token: string | null = null; // account-bound webhook token
  private authRequired = true; // false when the relay runs in self-host (no-auth) mode

  // Magic-link pending state
  private pollToken: string | null = null;
  private pendingEmail: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  private lastError: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private stopped = true;

  private statusCb: ((status: RelayStatus) => void) | null = null;
  private authCb: ((status: AuthStatus) => void) | null = null;

  onStatusChange(cb: (status: RelayStatus) => void): void {
    this.statusCb = cb;
  }
  onAuthChange(cb: (status: AuthStatus) => void): void {
    this.authCb = cb;
  }
  private emitStatus(): void {
    this.statusCb?.(this.getStatus());
  }
  private emitAuth(): void {
    this.authCb?.(this.getAuthStatus());
  }

  getStatus(): RelayStatus {
    return {
      enabled: this.enabled,
      connected: this.connected,
      relayBaseUrl: this.baseUrl,
      token: this.token,
      hookUrl: this.token ? `${trimSlash(this.baseUrl)}/hook/${this.token}` : null,
      error: this.lastError,
    };
  }

  getAuthStatus(): AuthStatus {
    return {
      signedIn: !!this.sessionToken,
      email: this.email,
      pro: this.pro,
      portalUrl: this.portalUrl,
      hookUrl: this.token ? `${trimSlash(this.baseUrl)}/hook/${this.token}` : null,
      pending: !!this.pollToken,
      pendingEmail: this.pendingEmail,
      authRequired: this.authRequired,
      error: this.lastError,
    };
  }

  /** Probe the relay's /health to detect whether it requires accounts. */
  private async probeHealth(): Promise<void> {
    try {
      const res = await fetch(`${trimSlash(this.baseUrl)}/health`);
      if (res.ok) {
        const data = (await res.json()) as { requiresAuth?: boolean };
        this.authRequired = data.requiresAuth !== false;
      }
    } catch {
      // Keep the previous assumption if the relay is unreachable.
    }
    this.emitAuth();
  }

  /** Load persisted config; connect if cloud enabled (and signed in when required). */
  async init(): Promise<void> {
    const settings = await settingsStore.get();
    this.baseUrl = settings.relayBaseUrl;
    this.enabled = settings.cloudEnabled;
    this.sessionToken = settings.sessionToken;
    this.email = settings.accountEmail;
    this.pro = settings.pro;
    this.token = settings.relayToken;
    this.emitAuth();
    if (this.enabled) {
      await this.start();
    } else {
      this.emitStatus();
    }
  }

  // ── Magic-link sign-in ───────────────────────────────────────────────────────
  async requestLink(email: string): Promise<void> {
    this.cancel(); // clear any prior pending attempt
    const res = await fetch(`${trimSlash(this.baseUrl)}/auth/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sign-in request failed (HTTP ${res.status}). ${text}`);
    }
    const data = (await res.json()) as { pollToken?: string };
    if (!data.pollToken) throw new Error("Relay did not return a poll token");
    this.pollToken = data.pollToken;
    this.pendingEmail = email.trim();
    this.lastError = undefined;
    logger.info("relay-client", "[auth:pending]", { email: this.pendingEmail });
    this.emitAuth();
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (!this.pollToken) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  private async pollOnce(): Promise<void> {
    const pollToken = this.pollToken;
    if (!pollToken) return;
    try {
      const res = await fetch(`${trimSlash(this.baseUrl)}/auth/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollToken }),
      });
      const data = (await res.json()) as {
        status: string;
        sessionToken?: string;
        email?: string;
        pro?: boolean;
      };
      if (data.status === "ok" && data.sessionToken) {
        this.pollToken = null;
        this.pendingEmail = null;
        this.sessionToken = data.sessionToken;
        this.email = data.email ?? null;
        this.pro = !!data.pro;
        await settingsStore.set({
          sessionToken: this.sessionToken,
          accountEmail: this.email,
          pro: this.pro,
        });
        logger.info("relay-client", "[auth:signed-in]", { email: this.email, pro: this.pro });
        this.emitAuth();
        await this.start();
        return;
      }
      if (data.status === "expired" || data.status === "not_found") {
        this.lastError = "Sign-in link expired. Please try again.";
        this.pollToken = null;
        this.pendingEmail = null;
        this.emitAuth();
        return;
      }
      // still pending
      this.schedulePoll();
    } catch (err) {
      logger.error("relay-client", "[auth:poll-failed]", err);
      this.schedulePoll(); // keep trying through transient errors
    }
  }

  cancel(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollToken = null;
    this.pendingEmail = null;
    this.emitAuth();
  }

  async signOut(): Promise<void> {
    const session = this.sessionToken;
    await this.stop();
    this.cancel();
    if (session) {
      try {
        await fetch(`${trimSlash(this.baseUrl)}/auth/signout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session}` },
        });
      } catch (err) {
        logger.error("relay-client", "sign-out request failed", err);
      }
    }
    this.sessionToken = null;
    this.email = null;
    this.pro = false;
    this.portalUrl = null;
    this.token = null;
    await settingsStore.set({ sessionToken: null, accountEmail: null, pro: false, relayToken: null });
    this.emitAuth();
    this.emitStatus();
  }

  // ── Billing ───────────────────────────────────────────────────────────────────
  /** Refresh plan + portal URL from the relay (/me). */
  private async fetchAccount(): Promise<void> {
    if (!this.sessionToken) return;
    try {
      const res = await fetch(`${trimSlash(this.baseUrl)}/me`, {
        headers: { Authorization: `Bearer ${this.sessionToken}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { pro?: boolean; portalUrl?: string | null };
      let changed = false;
      if (typeof data.pro === "boolean" && data.pro !== this.pro) {
        this.pro = data.pro;
        await settingsStore.set({ pro: this.pro });
        changed = true;
      }
      const portal = data.portalUrl ?? null;
      if (portal !== this.portalUrl) {
        this.portalUrl = portal;
        changed = true;
      }
      if (changed) this.emitAuth();
    } catch (err) {
      logger.error("relay-client", "fetchAccount failed", err);
    }
  }

  /** Open the checkout for this account in the default browser. */
  async openCheckout(plan: "monthly" | "yearly" = "monthly"): Promise<void> {
    if (!this.sessionToken) throw new Error("Sign in required");
    const res = await fetch(`${trimSlash(this.baseUrl)}/billing/checkout?plan=${plan}`, {
      headers: { Authorization: `Bearer ${this.sessionToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Checkout unavailable (HTTP ${res.status}). ${text}`);
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error("No checkout URL returned");
    await shell.openExternal(data.url);
  }

  /** Open the customer portal (manage/cancel subscription) in the browser.
   *  Fetches a fresh URL each time (Stripe portal sessions are short-lived). */
  async openPortal(): Promise<void> {
    if (!this.sessionToken) throw new Error("Sign in required");
    const res = await fetch(`${trimSlash(this.baseUrl)}/billing/portal`, {
      headers: { Authorization: `Bearer ${this.sessionToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Manage subscription unavailable (HTTP ${res.status}). ${text}`);
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error("No portal URL returned");
    await shell.openExternal(data.url);
  }

  // ── Webhook token + WebSocket ──────────────────────────────────────────────────
  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    const headers: Record<string, string> = {};
    if (this.authRequired) {
      if (!this.sessionToken) throw new Error("Not signed in");
      headers["Authorization"] = `Bearer ${this.sessionToken}`;
    }
    const res = await fetch(`${trimSlash(this.baseUrl)}/register`, { method: "POST", headers });
    if (res.status === 401 && this.authRequired) {
      // Session no longer valid — force re-auth.
      await this.signOut();
      throw new Error("Session expired");
    }
    if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error("register returned no token");
    this.token = data.token;
    await settingsStore.set({ relayToken: this.token });
    logger.info("relay-client", "[relay:registered]", { hookUrl: this.getStatus().hookUrl });
    return this.token;
  }

  /** True when we have everything needed to connect for the current relay mode. */
  private canConnect(): boolean {
    return this.authRequired ? !!this.sessionToken : true;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.enabled = true;
    await this.probeHealth();
    if (!this.canConnect()) {
      // Hosted relay but not signed in yet — wait for sign-in.
      this.emitStatus();
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.canConnect()) return;
    try {
      const token = await this.ensureToken();
      const ws = new WebSocket(toWsUrl(this.baseUrl, token));
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.lastError = undefined;
        this.reconnectDelay = 1000;
        console.log("[relay:connected]", { hookUrl: this.getStatus().hookUrl });
        logger.info("relay-client", "[relay:connected]", { hookUrl: this.getStatus().hookUrl });
        this.emitStatus();
        // Refresh plan + portal URL from the server.
        if (this.authRequired) void this.fetchAccount();
      };

      ws.onmessage = (ev: MessageEvent) => {
        this.handleMessage(typeof ev.data === "string" ? ev.data : "");
      };

      ws.onerror = () => {
        this.lastError = "Connection error";
      };

      ws.onclose = (ev: CloseEvent) => {
        this.connected = false;
        this.ws = null;
        if (ev.code === 1008) {
          // Token unknown to the relay — drop it and re-register on next attempt.
          this.token = null;
          settingsStore.set({ relayToken: null }).catch(() => {});
        }
        this.emitStatus();
        this.scheduleReconnect();
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error("relay-client", "[relay:connect-failed]", { error: this.lastError });
      this.emitStatus();
      if (this.canConnect()) this.scheduleReconnect();
    }
  }

  private handleMessage(text: string): void {
    try {
      const msg = JSON.parse(text) as {
        type?: string;
        raw?: string;
        pro?: boolean;
        message?: string;
        portalUrl?: string | null;
      };
      if (msg.type === "welcome") {
        if (typeof msg.pro === "boolean" && msg.pro !== this.pro) {
          this.pro = msg.pro;
          settingsStore.set({ pro: this.pro }).catch(() => {});
          this.emitAuth();
        }
        return;
      }
      if (msg.type === "entitlement" && typeof msg.pro === "boolean") {
        this.pro = msg.pro;
        if (typeof msg.portalUrl === "string" || msg.portalUrl === null) {
          this.portalUrl = msg.portalUrl;
        }
        settingsStore.set({ pro: this.pro }).catch(() => {});
        logger.info("relay-client", "[entitlement]", { pro: this.pro });
        if (this.pro) {
          try {
            new Notification({ title: "TradingView Alerts", body: "You're now on Pro — unlimited alerts." }).show();
          } catch {
            // ignore
          }
        }
        this.emitAuth();
        return;
      }
      if (msg.type === "alert" && typeof msg.raw === "string") {
        dispatchAlert(msg.raw, "cloud").catch((err) =>
          logger.error("relay-client", "dispatch failed", err),
        );
        return;
      }
      if (msg.type === "limit" && typeof msg.message === "string") {
        try {
          new Notification({ title: "TradingView Alerts — Upgrade to Pro", body: msg.message }).show();
        } catch {
          // ignore
        }
      }
    } catch (err) {
      logger.error("relay-client", "bad relay message", err);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.enabled || !this.canConnect() || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.emitStatus();
  }

  async setEnabled(enabled: boolean): Promise<RelayStatus> {
    await settingsStore.set({ cloudEnabled: enabled });
    this.enabled = enabled;
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }
    return this.getStatus();
  }

  async setBaseUrl(url: string): Promise<RelayStatus> {
    await this.stop();
    this.baseUrl = trimSlash(url);
    this.token = null; // re-register against the new relay
    this.reconnectDelay = 1000;
    await settingsStore.set({ relayBaseUrl: this.baseUrl, relayToken: null });
    if (this.enabled) {
      await this.start();
    }
    this.emitStatus();
    return this.getStatus();
  }
}

export const relayClient = new RelayClient();
