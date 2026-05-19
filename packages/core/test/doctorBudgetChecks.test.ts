import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { doctor } from "../src/usecases/doctor.js";

/**
 * v0.12 Task 7 — doctor budget checks.
 *
 * The plan's verbatim test sketch uses a hypothetical `runDoctor({ config,
 * usageAggregate })` signature, but the real `doctor()` reads disk. We follow
 * the disk-seed pattern already used by `runRoutePerProfileBudget.test.ts` and
 * `doctorEnvCheck.test.ts`:
 *   - write `tierkit.config.json` with profiles + budget.perProfile
 *   - write `.tierkit/plugins.json` empty registry
 *   - seed `.tierkit/runtime/usage.jsonl` with this-month records
 *   - call `doctor({ cwd })` and inspect `result.checks`.
 *
 * Real check shape uses `status: "ok" | "warn" | "fail"` and `detail` (the
 * existing schema) rather than the plan's `severity` / `message` naming —
 * we add `targetProfileId?` additively so callers can filter by profile.
 */

async function withWorkspace<T>(
  config: object,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-budget-"));
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

async function seedUsage(cwd: string, records: object[]) {
  const dir = path.join(cwd, ".tierkit/runtime");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "usage.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

const sonnetProfile = {
  kind: "public-cloud" as const,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  cost: { type: "per-token" as const, inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  requiresApproval: true,
  defaultMode: "review-only" as const,
};

const localCoderProfile = {
  kind: "local-device" as const,
  provider: "ollama",
  model: "qwen2.5-coder:7b",
};

describe("doctor v0.12 budget checks", () => {
  it("warns when paymentModel='free' has monthlyUsdLimit set", async () => {
    await withWorkspace(
      {
        version: "0.1",
        modelProfiles: { localCoder: localCoderProfile },
        budget: { perProfile: { localCoder: { monthlyUsdLimit: 5 } } },
      },
      async (cwd) => {
        const result = await doctor({ cwd });
        const warning = result.checks.find(
          (c) =>
            c.id === "flat-rate-or-free-with-usd-limit" &&
            c.targetProfileId === "localCoder",
        );
        expect(warning).toBeDefined();
        expect(warning?.status).toBe("warn");
        expect(warning?.detail ?? "").toMatch(/IGNORED/);
      },
    );
  });

  it("warns when paymentModel='flat-rate' has monthlyUsdLimit set", async () => {
    const claudeMax = {
      kind: "public-cloud" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      paymentModel: "flat-rate" as const,
      requiresApproval: true,
      defaultMode: "review-only" as const,
    };
    await withWorkspace(
      {
        version: "0.1",
        modelProfiles: { claudeMax },
        budget: { perProfile: { claudeMax: { monthlyUsdLimit: 200 } } },
      },
      async (cwd) => {
        const result = await doctor({ cwd });
        const warning = result.checks.find(
          (c) =>
            c.id === "flat-rate-or-free-with-usd-limit" &&
            c.targetProfileId === "claudeMax",
        );
        expect(warning).toBeDefined();
        expect(warning?.status).toBe("warn");
        expect(warning?.detail ?? "").toMatch(/DISPLAY-ONLY METADATA/);
      },
    );
  });

  it("warns when per-token profile is >=80% used on USD cap", async () => {
    await withWorkspace(
      {
        version: "0.1",
        modelProfiles: { claudeSonnet: sonnetProfile },
        budget: { perProfile: { claudeSonnet: { monthlyUsdLimit: 20 } } },
      },
      async (cwd) => {
        // Pre-feed usage: $16.40 this month -> 82% of $20 cap.
        await seedUsage(cwd, [
          {
            timestamp: new Date().toISOString(),
            profileId: "claudeSonnet",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            tier: "public-cloud",
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 16.4,
            latencyMs: 100,
            ok: true,
          },
        ]);
        const result = await doctor({ cwd });
        const warning = result.checks.find(
          (c) =>
            c.id === "per-profile-budget-near-threshold" &&
            c.targetProfileId === "claudeSonnet",
        );
        expect(warning).toBeDefined();
        expect(warning?.status).toBe("warn");
        expect(warning?.detail ?? "").toMatch(/82%/);
      },
    );
  });

  it("blocks (status: fail) when per-token profile cap is reached", async () => {
    await withWorkspace(
      {
        version: "0.1",
        modelProfiles: { claudeSonnet: sonnetProfile },
        budget: { perProfile: { claudeSonnet: { monthlyUsdLimit: 20 } } },
      },
      async (cwd) => {
        await seedUsage(cwd, [
          {
            timestamp: new Date().toISOString(),
            profileId: "claudeSonnet",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            tier: "public-cloud",
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 20.5,
            latencyMs: 100,
            ok: true,
          },
        ]);
        const result = await doctor({ cwd });
        const blocked = result.checks.find(
          (c) =>
            c.id === "per-profile-budget-blocked" &&
            c.targetProfileId === "claudeSonnet",
        );
        expect(blocked).toBeDefined();
        expect(blocked?.status).toBe("fail");
      },
    );
  });

  it("does NOT warn when per-token usage is <80%", async () => {
    await withWorkspace(
      {
        version: "0.1",
        modelProfiles: { claudeSonnet: sonnetProfile },
        budget: { perProfile: { claudeSonnet: { monthlyUsdLimit: 20 } } },
      },
      async (cwd) => {
        await seedUsage(cwd, [
          {
            timestamp: new Date().toISOString(),
            profileId: "claudeSonnet",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            tier: "public-cloud",
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 5.3,
            latencyMs: 100,
            ok: true,
          },
        ]);
        const result = await doctor({ cwd });
        const warnings = result.checks.filter(
          (c) => c.id === "per-profile-budget-near-threshold",
        );
        expect(warnings.length).toBe(0);
      },
    );
  });
});
