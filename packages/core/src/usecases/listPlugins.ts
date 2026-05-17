import { readRegistry, type RegistryEntry } from "../plugin/PluginRegistry.js";
import { loadConfig } from "../config/loadConfig.js";

export interface ListPluginsInput {
  cwd?: string;
}

/**
 * Each plugin returned by the daemon's `/v1/plugins` endpoint. The on-disk registry entry
 * doesn't carry an `enabled` flag — enable state lives in `tierkit.config.json`'s
 * `activePlugins` array. We join them here so callers (the sidebar GUI especially) can show
 * the current toggle state without having to fetch the config separately.
 */
export interface ListedPlugin extends RegistryEntry {
  enabled: boolean;
}

export interface ListPluginsResult {
  projectRoot: string;
  plugins: ListedPlugin[];
}

export async function listPlugins(input: ListPluginsInput = {}): Promise<ListPluginsResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const registry = await readRegistry(projectRoot);
  // loadConfig never throws on missing config — when there's no tierkit.config.json yet
  // it returns `found:false` with bundled defaults. So we can always safely look at
  // activePlugins without an extra existence check.
  const cfg = await loadConfig(projectRoot);
  const activeSet = new Set(cfg.config.activePlugins);
  const plugins: ListedPlugin[] = registry.plugins.map((p) => ({ ...p, enabled: activeSet.has(p.id) }));
  return { projectRoot, plugins };
}
