import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import type { ModelProfile } from "../model/ModelProfile.js";
import { pickProviderClient } from "../model/providers/index.js";
import type { ProbeResult } from "../model/providers/types.js";
import { appendUsage } from "../runtime/usageLog.js";

export interface TestModelInput {
  cwd?: string;
  profileId: string;
  env?: Record<string, string | undefined>;
  /** Run a short chat after probe to verify the provider actually responds. */
  smoke?: boolean;
  /** When true, skip the "profile is disabled" guard. GUI Test button passes true. */
  ignoreDisabled?: boolean;
  /** Override smoke chat timeout (ms). Default 30_000. */
  testTimeoutMs?: number;
}

export interface SmokeResult {
  ok: boolean;
  content?: string;
  inputTokens?: number;
  outputTokens?: number;
  usageSource?: "provider-reported" | "estimated";
  latencyMs: number;
  code?: string;
  message?: string;
}

export interface TestModelResult {
  profileId: string;
  profile: ModelProfile;
  result: ProbeResult;
  smoke?: SmokeResult;
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
  const profile = cfg.config.modelProfiles[input.profileId];
  if (!profile) {
    const known = Object.keys(cfg.config.modelProfiles);
    throw new TestModelError(
      "unknown-profile",
      `model profile "${input.profileId}" is not declared in tierkit.config.json. ` +
        (known.length > 0 ? `Known profiles: ${known.join(", ")}` : "No profiles configured."),
    );
  }

  if (input.ignoreDisabled !== true && (cfg.config.disabledProfileIds ?? []).includes(input.profileId)) {
    throw new TestModelError(
      "profile-disabled",
      `profile "${input.profileId}" is disabled. Pass ignoreDisabled:true to test it anyway.`,
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

  const probeResult = await client.probe(profile, env);
  let smoke: SmokeResult | undefined;
  if (input.smoke === true && probeResult.ok) {
    const testTimeoutMs = input.testTimeoutMs ?? 30_000;
    const tStarted = Date.now();
    try {
      // Brief, deterministic prompt. The provider may or may not echo verbatim — we only
      // care that it responded coherently.
      const chatResult = await client.chat(profile, {
        messages: [{ role: "user", content: "Reply with exactly: OK." }],
        maxTokens: 16,
      }, env);
      if (chatResult.ok) {
        smoke = {
          ok: true,
          content: chatResult.text,
          inputTokens: chatResult.usage.inputTokens,
          outputTokens: chatResult.usage.outputTokens,
          usageSource: chatResult.usageSource,
          latencyMs: chatResult.latencyMs,
        };
        // record in usage.jsonl with type:"model-test"
        const usagePath = path.join(projectRoot, ".tierkit", "usage.jsonl");
        await appendUsage(usagePath, {
          timestamp: new Date().toISOString(),
          profileId: input.profileId,
          provider: profile.provider,
          model: profile.model,
          tier: profile.kind,
          inputTokens: chatResult.usage.inputTokens,
          outputTokens: chatResult.usage.outputTokens,
          costUsd: 0,
          latencyMs: chatResult.latencyMs,
          ok: true,
          usageSource: chatResult.usageSource,
          type: "model-test",
        });
        void testTimeoutMs;
      } else {
        smoke = {
          ok: false,
          code: chatResult.code,
          message: (chatResult.message ?? "").slice(0, 500),
          latencyMs: chatResult.latencyMs,
        };
      }
    } catch (err) {
      smoke = {
        ok: false,
        code: "test-failed",
        message: String((err as Error)?.message ?? err).slice(0, 500),
        latencyMs: Date.now() - tStarted,
      };
    }
  }

  return { profileId: input.profileId, profile, result: probeResult, smoke };
}
