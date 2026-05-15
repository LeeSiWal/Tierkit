import { loadConfig, type ConfigSource } from "../config/loadConfig.js";
import type { ModelProfile } from "../model/ModelProfile.js";

export interface ListModelsInput {
  cwd?: string;
}

export interface ModelListEntry {
  id: string;
  profile: ModelProfile;
  /** Where this profile came from: bundled defaults, user-level config, or workspace config. */
  source: ConfigSource;
}

export interface ListModelsResult {
  projectRoot: string;
  configFound: boolean;
  /** Path to the workspace config (./tierkit.config.json), or null if none. */
  configPath: string | null;
  /** Path to the user config (~/.tierkit/config.json), or null if none. */
  userConfigPath: string | null;
  entries: ModelListEntry[];
}

export async function listModels(input: ListModelsInput = {}): Promise<ListModelsResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  const entries: ModelListEntry[] = Object.entries(cfg.config.modelProfiles).map(([id, profile]) => ({
    id,
    profile,
    source: cfg.profileSources[id] ?? "bundled",
  }));
  return {
    projectRoot,
    configFound: cfg.found,
    configPath: cfg.configPath,
    userConfigPath: cfg.userConfigPath,
    entries,
  };
}
