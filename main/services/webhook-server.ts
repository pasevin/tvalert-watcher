import * as http from "http";
import * as os from "os";

import { logger } from "@glaze/core/backend";

import { settingsStore } from "./settings-store.js";
import { dispatchAlert } from "./alert-dispatch.js";

export interface ServerStatus {
  running: boolean;
  port: number;
  endpoints: string[];
  error?: string;
}

const MAX_BODY_BYTES = 64 * 1024; // 64 KB cap

function getLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

function buildEndpoints(port: number): string[] {
  const endpoints = [`http://localhost:${port}/webhook`];
  const lan = getLanIp();
  if (lan) endpoints.push(`http://${lan}:${port}/webhook`);
  return endpoints;
}

class WebhookServer {
  private server: http.Server | null = null;
  private currentPort = 8765;
  private lastError: string | undefined;

  async start(port?: number): Promise<void> {
    const settings = await settingsStore.get();
    const targetPort = port ?? settings.port;

    if (this.server) {
      await this.stop();
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        this.lastError = `Server bind failed on port ${targetPort}: ${err.message} (code: ${err.code ?? "unknown"})`;
        logger.error("webhook-server", this.lastError, err);
        reject(new Error(this.lastError));
      });

      server.listen(targetPort, "0.0.0.0", () => {
        this.server = server;
        this.currentPort = targetPort;
        this.lastError = undefined;
        logger.info("webhook-server", "[server:start]", { port: targetPort });
        console.log("[server:start]", { port: targetPort });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  async restart(port: number): Promise<void> {
    await this.start(port);
  }

  getStatus(): ServerStatus {
    return {
      running: this.server !== null,
      port: this.currentPort,
      endpoints: buildEndpoints(this.currentPort),
      error: this.lastError,
    };
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "/";
    const isWebhook = req.method === "POST" && (url === "/webhook" || url === "/");

    if (!isWebhook) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
      return;
    }

    let body = "";
    let bytesReceived = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => {
      if (aborted) return;
      dispatchAlert(body, "local")
        .then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("webhook-server", "Error processing alert", { error: message });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        });
    });

    req.on("error", (err) => {
      logger.error("webhook-server", "Request error", err);
    });
  }
}

export const webhookServer = new WebhookServer();
