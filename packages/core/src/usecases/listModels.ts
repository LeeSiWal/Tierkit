import { loadConfig } from "../config/loadConfig.js";
import type { ModelProfile } from "../model/ModelProfile.js";

export interface ListModelsInput {
  cwd?: string;
}

export interface ModelListEntry {
  id: string;
  profile: ModelProfile;
}

export interface ListModelsResult {
  projectRoot: string;
  configFound: boolean;
  entries: ModelListEntry[];
}

export async function listModels(input: ListModelsInput = {}): Promise<ListModelsResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  const entries: ModelListEntry[] = Object.entries(cfg.config.modelProfiles).map(([id, profile]) => ({
    id,
    profile,
  }));
  return { projectRoot, configFound: cfg.found, entries };
}
