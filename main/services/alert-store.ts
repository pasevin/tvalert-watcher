import * as fs from "fs/promises";
import * as path from "path";

import { app } from "@glaze/core/backend";

export interface Alert {
  id: string;
  receivedAt: number;
  ticker?: string;
  message: string;
  price?: string;
  raw: string;
  read: boolean;
}

const MAX_ALERTS = 200;

class AlertStore {
  private cache: Alert[] | null = null;
  private filePath: string | null = null;

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = await app.getPath("userData");
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, "alerts.json");
    }
    return this.filePath;
  }

  private async load(): Promise<Alert[]> {
    if (this.cache !== null) return this.cache;
    try {
      const filePath = await this.getFilePath();
      const data = await fs.readFile(filePath, "utf-8");
      this.cache = JSON.parse(data) as Alert[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async save(alerts: Alert[]): Promise<void> {
    this.cache = alerts;
    const filePath = await this.getFilePath();
    await fs.writeFile(filePath, JSON.stringify(alerts, null, 2));
  }

  async list(): Promise<Alert[]> {
    return this.load();
  }

  async add(alert: Alert): Promise<Alert[]> {
    const alerts = await this.load();
    alerts.unshift(alert);
    const trimmed = alerts.slice(0, MAX_ALERTS);
    await this.save(trimmed);
    return trimmed;
  }

  async markAllRead(): Promise<Alert[]> {
    const alerts = await this.load();
    for (const a of alerts) a.read = true;
    await this.save(alerts);
    return alerts;
  }

  async delete(id: string): Promise<Alert[]> {
    const alerts = await this.load();
    const filtered = alerts.filter((a) => a.id !== id);
    await this.save(filtered);
    return filtered;
  }

  async clear(): Promise<Alert[]> {
    await this.save([]);
    return [];
  }

  async unreadCount(): Promise<number> {
    const alerts = await this.load();
    return alerts.filter((a) => !a.read).length;
  }
}

export const alertStore = new AlertStore();
