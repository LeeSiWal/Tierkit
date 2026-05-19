import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { runRoute } from "../src/usecases/runRoute.js";
import { MockModelClient } from "../src/model/providers/mock.js";

// Helper: build a workspace with a tierkit.config.json containing the given
// profiles and budget. The .tierkit/plugins.json registry is also seeded
// (matching the pattern in runRoute.test.ts) so the workflow gate sees an
// empty active plugin list -> effective freedom "free".
async function withWorkspace<T>(
  config: object,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-runRoute-budget-"));
  await fs.mkdir(path.join(tmp, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify(config));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// Helper: pre-seed usage log so the per-profile budget gate sees usage already.
async function seedUsage(cwd: string, records: object[]) {
  const dir = path.join(cwd, ".tierkit/runtime");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "usage.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

// Public-cloud profile with per-token cost data. requiresApproval + defaultMode
// are required for public-cloud profiles by ModelProfileSchema's superRefine.
const sonnetProfile = {
  kind: "public-cloud",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  requiresApproval: true,
  defaultMode: "review-only",
};

describe("runRoute per-profile budget gate", () => {
  it("blocks a per-token profile when monthly USD cap is exceeded, returning budget-exceeded with details", async () => {
    await withWorkspace(
      {
        version: "0.1",
        modelProfiles: { claudeSonnet: sonnetProfile },
        budget: { perProfile: { claudeSonnet: { monthlyUsdLimit: 5 } } },
      },
      async (cwd) => {
        // Pre-seed usage: $5.01 already spent this month on claudeSonnet —
        // strictly over the $5 monthly cap so the gate's `>` boundary fires
        // regardless of the small input-token estimate from the test prompt.
        await seedUsage(cwd, [
          {
            timestamp: new Date().toISOString(),
            profileId: "claudeSonnet",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            tier: "public-cloud",
            inputTokens: 1_670_000,
            outputTokens: 0,
            costUsd: 5.01,
            latencyMs: 100,
            ok: true,
          },
        ]);

        // Gate fires before stream, so no clientFactory is needed.
        const result = await runRoute({
          cwd,
          task: "say hi",
          profileId: "claudeSonnet",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("budget-exceeded");
          expect(result.message).toMatch(/per-profile budget policy/i);
          expect(result.details).toBeDefined();
          expect(result.details?.length).toBeGreaterThan(0);
          expect(result.details?.[0]?.profileId).toBe("claudeSonnet");
          expect(result.details?.[0]?.reason).toMatch(/monthly USD cap/);
        }
      },
    );
  });

  it("does NOT block when budget is not configured (back-compat)", async () => {
    await withWorkspace(
      {
        version: "0.1",
        modelProfiles: { claudeSonnet: sonnetProfile },
        // no budget field at all
      },
      async (cwd) => {
        const result = await runRoute({
          cwd,
          task: "say hi",
          profileId: "claudeSonnet",
          clientFactory: () => new MockModelClient({ chunks: ["hello"], inputTokens: 10, outputTokens: 1 }),
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          // drain stream so the usage record write completes cleanly
          for await (const _ of result.stream) {/* no-op */}
          await result.done;
        }
      },
    );
  });
});
