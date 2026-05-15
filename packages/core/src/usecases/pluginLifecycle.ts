import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { CONFIG_FILENAME, TierkitConfigSchema } from "../config/TierkitConfig.js";
import {
  readRegistry,
  removeEntry,
  TIERKIT_DIR,
} from "../plugin/PluginRegistry.js";
import { TierkitError } from "../errors/TierkitError.js";
import { syncPlugins, type SyncPluginsResult } from "./syncPlugins.js";
import type { TierkitAdapter } from "../adapter/TierkitAdapter.js";
import type { Target } from "../plugin/PluginManifest.js";

export class PluginLifecycleError extends TierkitError {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginLifecycleError";
    this.code = code;
  }
}

export interface PluginLifecycleInput {
  pluginId: string;
  cwd?: string;
  /**
   * Export adapters to pass to `syncPlugins` after the lifecycle change. When provided,
   * the plugin update propagates automatically to every connected coding agent (Roo/
   * Cline/Continue). Omit to skip auto-sync (the CLI does this for tests; users can
   * always re-sync manually with `tierkit plugin sync`).
   */
  adapters?: Partial<Record<Target, TierkitAdapter>>;
}

export interface PluginLifecycleResult {
  pluginId: string;
  /** activePlugins list after the operation. */
  activePlugins: string[];
  /** "enable" | "disable" | "remove". */
  action: string;
  /** Sync result if `adapters` was provided; undefined otherwise. */
  sync?: SyncPluginsResult;
}

async function writeConfig(projectRoot: string, raw: unknown): Promise<void> {
  // Re-parse to apply defaults and produce a clean serialization
  const parsed = TierkitConfigSchema.parse(raw);
  await fs.writeFile(
    path.join(projectRoot, CONFIG_FILENAME),
    JSON.stringify(parsed, null, 2) + "\n",
    "utf8",
  );
}

export async function enablePlugin(input: PluginLifecycleInput): Promise<PluginLifecycleResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  if (!cfg.found) throw new PluginLifecycleError("no-config", "no tierkit.config.json — run `tierkit init` first");

  const registry = await readRegistry(projectRoot);
  if (!registry.plugins.find((p) => p.id === input.pluginId)) {
    throw new PluginLifecycleError(
      "not-installed",
      `plugin "${input.pluginId}" is not installed. Install it first with \`tierkit plugin install <path>\`.`,
    );
  }

  const active = new Set(cfg.config.activePlugins);
  active.add(input.pluginId);
  const next = { ...cfg.config, activePlugins: [...active].sort() };
  await writeConfig(projectRoot, next);
  const sync = input.adapters
    ? await syncPlugins({ cwd: projectRoot, adapters: input.adapters })
    : undefined;
  return { pluginId: input.pluginId, activePlugins: next.activePlugins, action: "enable", ...(sync ? { sync } : {}) };
}

export async function disablePlugin(input: PluginLifecycleInput): Promise<PluginLifecycleResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  if (!cfg.found) throw new PluginLifecycleError("no-config", "no tierkit.config.json — run `tierkit init` first");

  const next = {
    ...cfg.config,
    activePlugins: cfg.config.activePlugins.filter((id) => id !== input.pluginId),
  };
  await writeConfig(projectRoot, next);
  const sync = input.adapters
    ? await syncPlugins({ cwd: projectRoot, adapters: input.adapters })
    : undefined;
  return { pluginId: input.pluginId, activePlugins: next.activePlugins, action: "disable", ...(sync ? { sync } : {}) };
}

export async function removePlugin(input: PluginLifecycleInput): Promise<PluginLifecycleResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);

  const registry = await readRegistry(projectRoot);
  const entry = registry.plugins.find((p) => p.id === input.pluginId);
  if (!entry) {
    throw new PluginLifecycleError(
      "not-installed",
      `plugin "${input.pluginId}" is not installed`,
    );
  }
  await fs.rm(entry.pluginDir, { recursive: true, force: true });
  await removeEntry(projectRoot, input.pluginId);

  // Also drop from activePlugins if config exists
  let active: string[] = [];
  if (cfg.found) {
    const next = {
      ...cfg.config,
      activePlugins: cfg.config.activePlugins.filter((id) => id !== input.pluginId),
    };
    await writeConfig(projectRoot, next);
    active = next.activePlugins;
  }
  return { pluginId: input.pluginId, activePlugins: active, action: "remove" };
}

export { TIERKIT_DIR };
