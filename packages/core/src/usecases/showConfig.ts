import { loadConfig } from "../config/loadConfig.js";
import type { TierkitConfig } from "../config/TierkitConfig.js";
import type { ModelProfile } from "../model/ModelProfile.js";

export interface ShowConfigInput {
  cwd?: string;
  /** Reveal `apiKeyEnv` values from process.env (mask by default). */
  revealEnvValues?: boolean;
}

export interface ShowConfigResult {
  projectRoot: string;
  configFound: boolean;
  configPath: string | null;
  config: TierkitConfig;
  /** Resolved env values for `apiKeyEnv` references — masked unless `revealEnvValues` is true. */
  apiKeyEnvStatus: { envVar: string; profileId: string; present: boolean; value?: string }[];
}

export async function showConfig(input: ShowConfigInput = {}): Promise<ShowConfigResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const result = await loadConfig(projectRoot);

  const apiKeyEnvStatus: ShowConfigResult["apiKeyEnvStatus"] = [];
  for (const [profileId, profile] of Object.entries(result.config.modelProfiles) as [string, ModelProfile][]) {
    if (!profile.apiKeyEnv) continue;
    const raw = process.env[profile.apiKeyEnv];
    const present = Boolean(raw && raw.length > 0);
    const entry: ShowConfigResult["apiKeyEnvStatus"][number] = {
      envVar: profile.apiKeyEnv,
      profileId,
      present,
    };
    if (present && input.revealEnvValues) entry.value = raw!;
    apiKeyEnvStatus.push(entry);
  }

  return {
    projectRoot,
    configFound: result.found,
    configPath: result.configPath,
    config: result.config,
    apiKeyEnvStatus,
  };
}
