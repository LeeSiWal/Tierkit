import fs from "node:fs/promises";
import path from "node:path";
import {
  TierkitConfigSchema,
  CONFIG_FILENAME,
  type TierkitConfig,
} from "./TierkitConfig.js";

export interface ConfigLoadResult {
  config: TierkitConfig;
  configPath: string | null;
  found: boolean;
}

const DEFAULT_CONFIG: TierkitConfig = TierkitConfigSchema.parse({
  version: "0.1",
});

export async function loadConfig(projectRoot: string): Promise<ConfigLoadResult> {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = TierkitConfigSchema.parse(JSON.parse(raw));
    return { config: parsed, configPath, found: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: DEFAULT_CONFIG, configPath: null, found: false };
    }
    throw err;
  }
}

export function defaultConfig(): TierkitConfig {
  return DEFAULT_CONFIG;
}
