import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  EmptyState,
  ScrollArea,
  Separator,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
} from "@glaze/core/components";
import { cn } from "@glaze/core/utils";
import { SettingsIcon, Trash2Icon, XIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Alert {
  id: string;
  receivedAt: number;
  ticker?: string;
  message: string;
  price?: string;
  raw: string;
  read: boolean;
}

interface ServerStatus {
  running: boolean;
  port: number;
  endpoints: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// IPC helper
// ---------------------------------------------------------------------------

function invoke<T>(channel: string, args?: unknown): Promise<T> {
  return window.glazeAPI.glaze.ipc.invoke<T>(channel, args);
}

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// Alert row component
// ---------------------------------------------------------------------------

interface AlertRowProps {
  alert: Alert;
  onDelete: (id: string) => void;
}

function AlertRow({ alert, onDelete }: AlertRowProps) {
  const [hovered, setHovered] = useState(false);
  const [relTime, setRelTime] = useState(() => relativeTime(alert.receivedAt));

  // Refresh relative time every 30s
  useEffect(() => {
    const timer = setInterval(() => {
      setRelTime(relativeTime(alert.receivedAt));
    }, 30_000);
    return () => clearInterval(timer);
  }, [alert.receivedAt]);

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-3 py-2 transition-colors",
        !alert.read && "bg-blue-3/40",
        hovered && "bg-gray-3",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Unread dot */}
      <span className={cn("mt-1.5 shrink-0 size-1.5 rounded-full", !alert.read ? "bg-blue-9" : "")} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {(alert.ticker || alert.price) && (
          <div className="flex items-baseline gap-2 min-w-0">
            {alert.ticker && (
              <span className="text-callout font-semibold text-gray-12 shrink-0 tabular-nums">
                {alert.ticker}
              </span>
            )}
            {alert.price && (
              <span className="text-footnote text-gray-11 shrink-0 tabular-nums">
                {alert.price}
              </span>
            )}
          </div>
        )}
        <p className="text-footnote text-gray-11 break-words">{alert.message}</p>
      </div>

      {/* Timestamp / delete */}
      <div className="flex items-center shrink-0 ml-auto">
        {hovered ? (
          <button
            className="flex items-center justify-center size-5 rounded hover:bg-gray-4 transition-colors"
            onClick={() => onDelete(alert.id)}
            aria-label="Delete alert"
          >
            <XIcon className="size-3 text-gray-11" />
          </button>
        ) : (
          <span className="text-caption1 text-gray-9 tabular-nums">{relTime}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server status indicator
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  status: ServerStatus | undefined;
  isLoading: boolean;
}

function StatusBadge({ status, isLoading }: StatusBadgeProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-gray-6 animate-pulse shrink-0" />
        <span className="text-caption1 text-gray-9">Connecting…</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-red-9 shrink-0" />
        <span className="text-caption1 text-red-11">Unavailable</span>
      </div>
    );
  }

  if (!status.running || status.error) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-red-9 shrink-0" />
        <span className="text-caption1 text-red-11 truncate max-w-40">
          {status.error ?? "Server stopped"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="size-1.5 rounded-full bg-green-9 shrink-0" />
      <span className="text-caption1 text-gray-11 tabular-nums">
        Listening on :{status.port}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home view
// ---------------------------------------------------------------------------

export function HomeView() {
  const queryClient = useQueryClient();
  const markReadScheduled = useRef(false);

  // ---- Queries ----

  const alertsQuery = useQuery<Alert[]>({
    queryKey: ["alerts"],
    queryFn: () => {
      console.log("[Panel:alerts:list] fetching alerts");
      return invoke<Alert[]>("alerts:list");
    },
    staleTime: 0,
  });

  const statusQuery = useQuery<ServerStatus>({
    queryKey: ["server:status"],
    queryFn: () => {
      console.log("[Panel:server:getStatus] fetching status");
      return invoke<ServerStatus>("server:getStatus");
    },
    staleTime: 10_000,
  });

  // ---- Mark all read after brief delay on mount ----

  useEffect(() => {
    if (markReadScheduled.current) return;
    markReadScheduled.current = true;
    const timer = setTimeout(async () => {
      try {
        console.log("[Panel:alerts:markAllRead] marking all read");
        await invoke<{ ok: true }>("alerts:markAllRead");
        queryClient.setQueryData<Alert[]>(["alerts"], (prev) =>
          prev ? prev.map((a) => ({ ...a, read: true })) : prev,
        );
      } catch (err) {
        console.error("[Panel:alerts:markAllRead] error", err);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [queryClient]);

  // ---- Live subscriptions ----

  useEffect(() => {
    const unsubNew = window.glazeAPI.glaze.ipc.onNotification(
      "alerts:new",
      (params: unknown) => {
        const { alert, unreadCount } = params as { alert: Alert; unreadCount: number };
        console.log("[Panel:alerts:new]", { id: alert.id, unreadCount });
        queryClient.setQueryData<Alert[]>(["alerts"], (prev) =>
          prev ? [alert, ...prev] : [alert],
        );
      },
    );

    const unsubChanged = window.glazeAPI.glaze.ipc.onNotification(
      "alerts:changed",
      (params: unknown) => {
        const { unreadCount } = params as { unreadCount: number };
        console.log("[Panel:alerts:changed]", { unreadCount });
        queryClient.invalidateQueries({ queryKey: ["alerts"] });
      },
    );

    const unsubStatus = window.glazeAPI.glaze.ipc.onNotification(
      "server:status-changed",
      (params: unknown) => {
        const status = params as ServerStatus;
        console.log("[Panel:server:status-changed]", { running: status.running, port: status.port });
        queryClient.setQueryData<ServerStatus>(["server:status"], status);
      },
    );

    return () => {
      unsubNew();
      unsubChanged();
      unsubStatus();
    };
  }, [queryClient]);

  // ---- Handlers ----

  const handleDelete = async (id: string) => {
    console.log("[Panel:alerts:delete]", { id });
    try {
      await invoke<{ ok: true }>("alerts:delete", { id });
      queryClient.setQueryData<Alert[]>(["alerts"], (prev) =>
        prev ? prev.filter((a) => a.id !== id) : prev,
      );
    } catch (err) {
      console.error("[Panel:alerts:delete] error", err);
    }
  };

  const handleClear = async () => {
    console.log("[Panel:alerts:clear] clearing all alerts");
    await invoke<{ ok: true }>("alerts:clear");
    queryClient.setQueryData<Alert[]>(["alerts"], []);
  };

  const handleOpenSettings = () => {
    console.log("[Panel:window:openSettings]");
    window.glazeAPI.glaze.ipc.invoke("window:openSettings");
  };

  // ---- Derived state ----

  const alerts = alertsQuery.data ?? [];
  const hasAlerts = alerts.length > 0;
  const webhookUrl =
    statusQuery.data?.endpoints?.[0] ??
    `http://localhost:${statusQuery.data?.port ?? 9876}/webhook`;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Compact header toolbar */}
      <Toolbar>
        <ToolbarContent>
          <StatusBadge status={statusQuery.data} isLoading={statusQuery.isLoading} />
        </ToolbarContent>
        <ToolbarActions>
          {hasAlerts && (
            <AlertDialog
              trigger={
                <Button variant="glass" size="large" iconOnly aria-label="Clear all alerts">
                  <Trash2Icon className="size-4.5 text-gray-11" />
                </Button>
              }
              title="Clear all alerts?"
              description="This will permanently delete all alerts from the list. This action cannot be undone."
              confirmLabel="Clear"
              confirmVariant="destructive"
              onConfirm={handleClear}
            />
          )}
          <Button
            variant="glass"
            size="large"
            iconOnly
            onClick={handleOpenSettings}
            aria-label="Open settings"
          >
            <SettingsIcon className="size-4.5 text-gray-11" />
          </Button>
        </ToolbarActions>
      </Toolbar>

      <Separator />

      {/* Alert list */}
      {alertsQuery.isLoading ? (
        <div className="flex-1 flex flex-col">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1 px-3 py-2.5">
              <div className="h-3 w-16 rounded bg-gray-4 animate-pulse" />
              <div className="h-3 w-40 rounded bg-gray-3 animate-pulse" />
            </div>
          ))}
        </div>
      ) : !hasAlerts ? (
        <div className="flex-1 relative">
          <EmptyState
            title="No alerts yet"
            description={
              <>
                Alerts will appear here when TradingView fires them. Point your webhook at:{" "}
                <span className="font-mono text-gray-11 select-all break-all">{webhookUrl}</span>
              </>
            }
          />
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex flex-col">
            {alerts.map((alert, i) => (
              <div key={alert.id}>
                <AlertRow alert={alert} onDelete={handleDelete} />
                {i < alerts.length - 1 && <Separator />}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
