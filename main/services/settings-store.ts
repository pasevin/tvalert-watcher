import * as fs from "fs/promises";
import * as path from "path";

import { app } from "@glaze/core/backend";

export interface Settings {
  port: number;
  notifications: boolean;
  sound: boolean;
  badge: boolean;
  // Cloud relay
  relayBaseUrl: string;
  relayToken: string | null;
  cloudEnabled: boolean;
  // Account (magic-link auth)
  sessionToken: string | null;
  accountEmail: string | null;
  pro: boolean;
}

const DEFAULTS: Settings = {
  port: 8765,
  notifications: true,
  sound: true,
  badge: true,
  relayBaseUrl: "https://alert-watcher-relay.fly.dev",
  relayToken: null,
  cloudEnabled: true,
  sessionToken: null,
  accountEmail: null,
  pro: false,
};

class SettingsStore {
  private cache: Settings | null = null;
  private filePath: string | null = null;

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = await app.getPath("userData");
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, "settings.json");
    }
    return this.filePath;
  }

  async get(): Promise<Settings> {
    if (this.cache !== null) return this.cache;
    try {
      const filePath = await this.getFilePath();
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data) as Partial<Settings>;
      this.cache = { ...DEFAULTS, ...parsed };
    } catch {
      this.cache = { ...DEFAULTS };
    }
    return this.cache;
  }

  async set(partial: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const updated: Settings = { ...current, ...partial };
    this.cache = updated;
    const filePath = await this.getFilePath();
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2));
    return updated;
  }
}

export const settingsStore = new SettingsStore();
