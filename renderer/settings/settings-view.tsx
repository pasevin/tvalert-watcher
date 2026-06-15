import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Field,
  FieldSeparator,
  FieldSet,
  Input,
  ScrollArea,
  Status,
  Switch,
  Separator,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
  toast,
} from "@glaze/core/components";
import { InfoIcon, CopyIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Settings {
  port: number;
  notifications: boolean;
  sound: boolean;
  badge: boolean;
  relayBaseUrl: string;
  relayToken: string | null;
  cloudEnabled: boolean;
}

interface ServerStatus {
  running: boolean;
  port: number;
  endpoints: string[];
  error?: string;
}

interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  relayBaseUrl: string;
  token: string | null;
  hookUrl: string | null;
  error?: string;
}

interface AuthStatus {
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

// ---------------------------------------------------------------------------
// IPC helper
// ---------------------------------------------------------------------------

function invoke<T>(channel: string, args?: unknown): Promise<T> {
  return window.glazeAPI.glaze.ipc.invoke<T>(channel, args);
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

export function SettingsView() {
  const queryClient = useQueryClient();

  // ---- Queries ----

  const settingsQuery = useQuery<Settings>({
    queryKey: ["settings"],
    queryFn: () => {
      console.log("[Settings:settings:get] fetching settings");
      return invoke<Settings>("settings:get");
    },
  });

  const statusQuery = useQuery<ServerStatus>({
    queryKey: ["server:status"],
    queryFn: () => {
      console.log("[Settings:server:getStatus] fetching status");
      return invoke<ServerStatus>("server:getStatus");
    },
  });

  const relayQuery = useQuery<RelayStatus>({
    queryKey: ["relay:status"],
    queryFn: () => {
      console.log("[Settings:relay:getStatus] fetching relay status");
      return invoke<RelayStatus>("relay:getStatus");
    },
  });

  const authQuery = useQuery<AuthStatus>({
    queryKey: ["auth:status"],
    queryFn: () => {
      console.log("[Settings:auth:status] fetching auth status");
      return invoke<AuthStatus>("auth:status");
    },
  });

  // ---- Port field local state ----

  const settings = settingsQuery.data;
  const [portInput, setPortInput] = useState<string>("");
  const portInitialized = useRef(false);

  useEffect(() => {
    if (settings && !portInitialized.current) {
      portInitialized.current = true;
      setPortInput(String(settings.port));
    }
  }, [settings]);

  // ---- Relay URL field local state ----

  const relay = relayQuery.data;
  const [relayUrlInput, setRelayUrlInput] = useState<string>("");
  const relayInitialized = useRef(false);

  useEffect(() => {
    if (relay && !relayInitialized.current) {
      relayInitialized.current = true;
      setRelayUrlInput(relay.relayBaseUrl);
    }
  }, [relay]);

  // ---- Auth email input local state ----

  const [emailInput, setEmailInput] = useState<string>("");


  // ---- Live subscriptions ----

  useEffect(() => {
    const unsubSettings = window.glazeAPI.glaze.ipc.onNotification(
      "settings:changed",
      (params: unknown) => {
        const updated = params as Settings;
        console.log("[Settings:settings:changed]", { ...updated });
        queryClient.setQueryData<Settings>(["settings"], updated);
        setPortInput(String(updated.port));
      },
    );

    const unsubStatus = window.glazeAPI.glaze.ipc.onNotification(
      "server:status-changed",
      (params: unknown) => {
        const status = params as ServerStatus;
        console.log("[Settings:server:status-changed]", { running: status.running, port: status.port });
        queryClient.setQueryData<ServerStatus>(["server:status"], status);
      },
    );

    const unsubRelay = window.glazeAPI.glaze.ipc.onNotification(
      "relay:status-changed",
      (params: unknown) => {
        const relay = params as RelayStatus;
        console.log("[Settings:relay:status-changed]", { connected: relay.connected, enabled: relay.enabled });
        queryClient.setQueryData<RelayStatus>(["relay:status"], relay);
      },
    );

    const unsubAuth = window.glazeAPI.glaze.ipc.onNotification(
      "auth:changed",
      (params: unknown) => {
        const auth = params as AuthStatus;
        console.log("[Settings:auth:changed]", { signedIn: auth.signedIn, email: auth.email, pending: auth.pending });
        queryClient.setQueryData<AuthStatus>(["auth:status"], auth);
      },
    );

    return () => {
      unsubSettings();
      unsubStatus();
      unsubRelay();
      unsubAuth();
    };
  }, [queryClient]);

  // ---- Escape to close ----

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;

      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }

      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }

      event.preventDefault();
      window.glazeAPI.glaze.ipc.invoke("window:closeSettings");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ---- Handlers ----

  const handleSavePort = async () => {
    const port = parseInt(portInput, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      toast.error("Port must be a number between 1 and 65535.");
      return;
    }
    console.log("[Settings:server:setPort]", { port });
    try {
      const status = await invoke<ServerStatus>("server:setPort", { port });
      queryClient.setQueryData<ServerStatus>(["server:status"], status);
      queryClient.setQueryData<Settings>(["settings"], (prev) =>
        prev ? { ...prev, port } : prev,
      );
      toast.success(`Webhook server restarted on port ${status.port}.`);
    } catch (err) {
      console.error("[Settings:server:setPort] error", err);
      toast.error(`Failed to set port: ${err}`);
    }
  };

  const handleCopyHookUrl = async () => {
    if (!relay?.hookUrl) return;
    try {
      await navigator.clipboard.writeText(relay.hookUrl);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Couldn't copy — select the URL and press ⌘C.");
    }
  };

  const handleToggleCloud = async (enabled: boolean) => {
    console.log("[Settings:relay:setEnabled]", { enabled });
    try {
      const status = await invoke<RelayStatus>("relay:setEnabled", { enabled });
      queryClient.setQueryData<RelayStatus>(["relay:status"], status);
    } catch (err) {
      console.error("[Settings:relay:setEnabled] error", err);
      toast.error(`Failed to update cloud relay: ${err}`);
    }
  };

  const handleRequestLink = async () => {
    const email = emailInput.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    console.log("[Settings:auth:requestLink]", { email });
    try {
      await invoke<{ ok: true }>("auth:requestLink", { email });
      toast.success("Check your email for a sign-in link.");
    } catch (err) {
      console.error("[Settings:auth:requestLink] error", err);
      toast.error(`Failed to send sign-in link: ${err}`);
    }
  };

  const handleCancelAuth = async () => {
    console.log("[Settings:auth:cancel]");
    try {
      const auth = await invoke<AuthStatus>("auth:cancel");
      console.log("[Settings:auth:cancel] result", { signedIn: auth.signedIn, pending: auth.pending });
      queryClient.setQueryData<AuthStatus>(["auth:status"], auth);
    } catch (err) {
      console.error("[Settings:auth:cancel] error", err);
      toast.error(`Failed to cancel: ${err}`);
    }
  };

  const handleSignOut = async () => {
    console.log("[Settings:auth:signOut]");
    try {
      const auth = await invoke<AuthStatus>("auth:signOut");
      console.log("[Settings:auth:signOut] result", { signedIn: auth.signedIn });
      queryClient.setQueryData<AuthStatus>(["auth:status"], auth);
    } catch (err) {
      console.error("[Settings:auth:signOut] error", err);
      toast.error(`Failed to sign out: ${err}`);
    }
  };

  const handleSaveRelayUrl = async () => {
    const url = relayUrlInput.trim();
    if (!/^https?:\/\//.test(url)) {
      toast.error("Relay URL must start with http:// or https://");
      return;
    }
    console.log("[Settings:relay:setBaseUrl]", { url });
    try {
      const status = await invoke<RelayStatus>("relay:setBaseUrl", { url });
      queryClient.setQueryData<RelayStatus>(["relay:status"], status);
      toast.success("Relay server updated.");
    } catch (err) {
      console.error("[Settings:relay:setBaseUrl] error", err);
      toast.error(`Failed to set relay server: ${err}`);
    }
  };

  const handleUpgradeToPro = async (plan: "monthly" | "yearly") => {
    console.log("[Settings:billing:openCheckout]", { plan, email: authQuery.data?.email });
    try {
      await invoke<{ ok: true }>("billing:openCheckout", { plan });
      toast.success("Opening checkout in your browser…");
    } catch (err) {
      console.error("[Settings:billing:openCheckout] error", err);
      toast.error(`Failed to open checkout: ${err}`);
    }
  };

  const handleManageSubscription = async () => {
    console.log("[Settings:billing:openPortal]", { email: authQuery.data?.email });
    try {
      await invoke<{ ok: true }>("billing:openPortal");
    } catch (err) {
      console.error("[Settings:billing:openPortal] error", err);
      toast.error(`Failed to open subscription portal: ${err}`);
    }
  };

  const handleToggle = async (field: "notifications" | "sound" | "badge", value: boolean) => {
    console.log("[Settings:settings:set]", { [field]: value });
    try {
      const updated = await invoke<Settings>("settings:set", { [field]: value });
      queryClient.setQueryData<Settings>(["settings"], updated);
    } catch (err) {
      console.error("[Settings:settings:set] error", err);
      toast.error(`Failed to save setting: ${err}`);
    }
  };

  // ---- Derived ----

  const status = statusQuery.data;
  const primaryEndpoint =
    status?.endpoints?.[0] ?? `http://localhost:${settings?.port ?? 9876}/webhook`;
  const lanEndpoint = status?.endpoints?.[1] ?? null;

  const isLoading = settingsQuery.isLoading;

  const auth = authQuery.data;

  // ---- Account tab content ----

  function AccountTab() {
    // Self-hosted: no account needed
    if (auth?.authRequired === false) {
      return (
        <div className="px-4 flex flex-col gap-6 pb-8 pt-2">
          <FieldSet title="Account">
            <Field orientation="horizontal">
              <p className="text-footnote text-gray-11 leading-snug">
                Self-hosted relay — no account needed.
              </p>
            </Field>
          </FieldSet>
          <FieldSet title="Webhook URL">
            <Field label="Your Webhook URL" orientation="horizontal">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-footnote text-gray-11 select-all break-all">
                  {relay?.hookUrl ?? "—"}
                </span>
                {relay?.hookUrl && (
                  <Button
                    variant="transparent"
                    size="small"
                    onClick={handleCopyHookUrl}
                    aria-label="Copy webhook URL"
                  >
                    <CopyIcon className="size-4" />
                  </Button>
                )}
              </div>
            </Field>
          </FieldSet>
        </div>
      );
    }

    // Signed in
    if (auth?.signedIn) {
      const relayConnected = relay?.connected ?? false;
      const relayEnabled = relay?.enabled ?? false;
      const relayStatusText = !auth.pro
        ? "Inactive — Pro required"
        : !relayEnabled
          ? "Disabled"
          : relayConnected
            ? "Connected"
            : "Connecting…";
      const relayDotClass = !auth.pro || !relayEnabled
        ? "bg-gray-8"
        : relayConnected
          ? "bg-green-9"
          : "bg-amber-9";

      return (
        <div className="px-4 flex flex-col gap-6 pb-8 pt-2">
          <FieldSet title="Account">
            <Field label="Email" orientation="horizontal">
              <span className="text-footnote text-gray-11">{auth.email}</span>
            </Field>
            <FieldSeparator />
            <Field label="Plan" orientation="horizontal">
              <Status variant={auth.pro ? "success" : "default"}>
                {auth.pro ? "Pro" : "Free"}
              </Status>
            </Field>
            {!auth.pro && (
              <>
                <FieldSeparator />
                <Field label="Upgrade to Pro" orientation="horizontal">
                  <div className="flex items-center gap-2">
                    <Button variant="filled" onClick={() => handleUpgradeToPro("monthly")}>
                      $4.99 / mo
                    </Button>
                    <Button variant="accent" onClick={() => handleUpgradeToPro("yearly")}>
                      $40 / yr · save 33%
                    </Button>
                  </div>
                </Field>
              </>
            )}
            {auth.pro && auth.portalUrl && (
              <>
                <FieldSeparator />
                <Field orientation="horizontal">
                  <Button variant="transparent" onClick={handleManageSubscription}>
                    Manage Subscription
                  </Button>
                </Field>
              </>
            )}
            <FieldSeparator />
            <Field orientation="horizontal">
              <Button variant="transparent" onClick={handleSignOut}>
                Sign Out
              </Button>
            </Field>
          </FieldSet>

          <FieldSet title="Cloud Relay">
            <Field label="Status" orientation="horizontal">
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full shrink-0 ${relayDotClass}`} />
                <span className="text-footnote text-gray-11">{relayStatusText}</span>
              </div>
            </Field>
            <FieldSeparator />
            <Field label="Your Webhook URL" orientation="horizontal">
              {auth.pro ? (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-footnote text-gray-11 select-all break-all">
                    {relay?.hookUrl ?? "—"}
                  </span>
                  {relay?.hookUrl && (
                    <Button
                      variant="transparent"
                      size="small"
                      onClick={handleCopyHookUrl}
                      aria-label="Copy webhook URL"
                    >
                      <CopyIcon className="size-4" />
                    </Button>
                  )}
                </div>
              ) : (
                <span className="text-footnote text-gray-a9 leading-snug">
                  Upgrade to Pro to activate your webhook — or self-host for free
                  (Settings → Local Webhook).
                </span>
              )}
            </Field>
          </FieldSet>
        </div>
      );
    }

    // Pending sign-in
    if (auth?.pending) {
      return (
        <div className="px-4 flex flex-col gap-6 pb-8 pt-2">
          <FieldSet title="Account">
            <Field orientation="horizontal">
              <p className="text-footnote text-gray-11 leading-snug">
                We emailed a sign-in link to{" "}
                <span className="font-semibold text-gray-12">{auth.pendingEmail}</span>.
                Click it to finish signing in.
              </p>
            </Field>
            <FieldSeparator />
            <Field orientation="horizontal">
              <Button variant="transparent" onClick={handleCancelAuth}>
                Cancel
              </Button>
            </Field>
          </FieldSet>
        </div>
      );
    }

    // Signed out
    return (
      <div className="px-4 flex flex-col gap-6 pb-8 pt-2">
        <div className="flex flex-col gap-3 pt-4">
          <p className="text-headlineEmphasized text-gray-12">Get alerts, instantly</p>
          <p className="text-callout text-gray-11 leading-snug">
            TradingView Alerts Pro gives you a personal webhook URL that works the moment you
            sign in — no tunnel, no setup.
          </p>
          <ul className="text-footnote text-gray-11 leading-snug list-disc pl-4 flex flex-col gap-1">
            <li>Personal webhook URL — paste it once into TradingView</li>
            <li>Never miss an alert — alerts that fire while you're offline are saved and delivered when you reopen the app</li>
            <li>Spot alerts at a glance with crypto &amp; stock logos</li>
            <li>Click any alert to jump straight to its TradingView chart</li>
          </ul>
          <p className="text-footnote text-gray-a10 leading-snug">
            $4.99/mo or $40/yr — sign in to start (it also creates your account); you'll pick a
            plan next. Prefer free? Self-host the relay or use the built-in local webhook below.
          </p>
        </div>
        <FieldSet title="Email">
          <Field label="Email address" orientation="horizontal">
            <div className="flex items-center gap-2">
              <Input
                type="email"
                value={emailInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmailInput(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") handleRequestLink();
                }}
                placeholder="you@example.com"
                className="w-48"
                aria-label="Email address"
              />
              <Button variant="accent" onClick={handleRequestLink}>
                Send Sign-in Link
              </Button>
            </div>
          </Field>
        </FieldSet>
      </div>
    );
  }

  // ---- Settings tab content ----

  function PreferencesTab() {
    return (
      <div className="px-4 flex flex-col gap-6 pb-8 pt-2">
        {/* Notifications */}
        <FieldSet title="Notifications">
          <Field label="System Notifications" orientation="horizontal">
            <Switch
              checked={settings?.notifications ?? false}
              onCheckedChange={(v: boolean) => handleToggle("notifications", v)}
              disabled={isLoading}
              aria-label="System notifications"
            />
          </Field>
          <FieldSeparator />
          <Field label="Sound" orientation="horizontal">
            <Switch
              checked={settings?.sound ?? false}
              onCheckedChange={(v: boolean) => handleToggle("sound", v)}
              disabled={isLoading}
              aria-label="Notification sound"
            />
          </Field>
          <FieldSeparator />
          <Field label="Menu-bar Badge" orientation="horizontal">
            <Switch
              checked={settings?.badge ?? false}
              onCheckedChange={(v: boolean) => handleToggle("badge", v)}
              disabled={isLoading}
              aria-label="Menu-bar badge"
            />
          </Field>
        </FieldSet>

        {/* Cloud Relay toggle */}
        <FieldSet title="Cloud Relay">
          <Field label="Enable Cloud Relay" orientation="horizontal">
            <Switch
              checked={relay?.enabled ?? false}
              onCheckedChange={handleToggleCloud}
              aria-label="Enable cloud relay"
            />
          </Field>
        </FieldSet>

        {/* Local Webhook (Advanced) */}
        <FieldSet title="Local Webhook (Advanced)">
          <Field label="Port" orientation="horizontal">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={65535}
                value={portInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPortInput(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") handleSavePort();
                }}
                className="w-24 tabular-nums"
                disabled={isLoading}
                aria-label="Webhook port"
              />
              <Button variant="filled" onClick={handleSavePort} disabled={isLoading}>
                Save
              </Button>
            </div>
          </Field>
          <FieldSeparator />
          <Field label="Local URL" orientation="horizontal">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono text-footnote text-gray-11 select-all break-all">
                {primaryEndpoint}
              </span>
              {lanEndpoint && (
                <span className="font-mono text-footnote text-gray-9 select-all break-all">
                  {lanEndpoint}
                </span>
              )}
            </div>
          </Field>
          <FieldSeparator />
          <Field label="Relay Server" orientation="horizontal">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={relayUrlInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRelayUrlInput(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") handleSaveRelayUrl();
                }}
                className="w-52 font-mono text-footnote"
                placeholder="https://your-relay.fly.dev"
                aria-label="Relay server URL"
              />
              <Button variant="filled" onClick={handleSaveRelayUrl}>
                Save
              </Button>
            </div>
          </Field>
        </FieldSet>

        {/* Amber tunnel note */}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-3 border border-amber-6">
          <InfoIcon className="size-4 text-amber-11 shrink-0 mt-0.5" />
          <p className="text-footnote text-amber-12 leading-snug">
            The local URL only works if you expose it yourself (e.g.{" "}
            <span className="font-mono">ngrok http {settings?.port ?? 8765}</span>). Most people
            should use the Cloud Relay instead.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea
      toolbar={
        <Toolbar>
          <ToolbarContent>
            <ToolbarTitle>Settings</ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
      }
    >
      {AccountTab()}
      <div className="px-4">
        <Separator />
      </div>
      {PreferencesTab()}
    </ScrollArea>
  );
}
