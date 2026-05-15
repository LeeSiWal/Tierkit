import { loadConfig } from "../config/loadConfig.js";
import type { ModelProfile } from "../model/ModelProfile.js";
import { pickProviderClient } from "../model/providers/index.js";
import type { ProbeResult } from "../model/providers/types.js";

export interface TestModelInput {
  cwd?: string;
  profileId: string;
  /** Optional env override for tests (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export interface TestModelResult {
  profileId: string;
  profile: ModelProfile;
  result: ProbeResult;
}

export class TestModelError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TestModelError";
    this.code = code;
  }
}

export async function testModel(input: TestModelInput): Promise<TestModelResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const env = input.env ?? (process.env as Record<string, string | undefined>);

  const cfg = await loadConfig(projectRoot);
  if (!cfg.found) {
    throw new TestModelError(
      "no-config",
      "no tierkit.config.json found in project. Run `tierkit init` first.",
    );
  }
  const profile = cfg.config.modelProfiles[input.profileId];
  if (!profile) {
    const known = Object.keys(cfg.config.modelProfiles);
    throw new TestModelError(
      "unknown-profile",
      `model profile "${input.profileId}" is not declared in tierkit.config.json. ` +
        (known.length > 0 ? `Known profiles: ${known.join(", ")}` : "No profiles configured."),
    );
  }

  const client = pickProviderClient(profile);
  if (!client) {
    return {
      profileId: input.profileId,
      profile,
      result: {
        ok: false,
        code: "not-implemented",
        message: `provider "${profile.provider}" does not have a Tierkit probe client yet`,
        latencyMs: 0,
      },
    };
  }

  const result = await client.probe(profile, env);
  return { profileId: input.profileId, profile, result };
}
