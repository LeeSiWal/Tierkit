import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAutoCandidates } from "../src/runtime/proxy/autoResolver.js";

let tmp: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-autoresolver-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp; // isolate from real ~/.tierkit in tests
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        // localFast viable check is skipped (provider !== ollama, so checkProfileViability passes)
        localFast:    { kind: "local-device", provider: "mock", model: "tiny", roles: [] },
        claudeHaiku:  { kind: "private-remote", provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [] },
        claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [], goodAt: ["code-review"] },
      },
      routingPolicy: {
        autoEscalationCeiling: "private-remote",
        budgetAwareDowngrade: false,
        responseQualityCheck: true,
        riskThresholds: { localFastMax: 25, localStrongMax: 50, privateRemoteMax: 75, publicCloudReviewMin: 76 },
      },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("resolveAutoCandidates", () => {
  it("returns candidate ids + classified taskType", async () => {
    const r = await resolveAutoCandidates({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "sk-ant-test1234567890" },
      lastUserMessage: "please review this function",
    });
    expect(r.taskType).toBe("code-review");
    // Both localFast and Claude profiles should be present (private-remote ceiling, ANTHROPIC_API_KEY set).
    expect(r.candidateIds).toContain("localFast");
    expect(r.candidateIds).toContain("claudeSonnet");
    expect(r.candidateIds).toContain("claudeHaiku");
    // claudeSonnet (goodAt code-review) should come before claudeHaiku within private-remote.
    expect(r.candidateIds.indexOf("claudeSonnet")).toBeLessThan(r.candidateIds.indexOf("claudeHaiku"));
  });

  it("drops private-remote candidates when ANTHROPIC_API_KEY is missing (non-viable)", async () => {
    const r = await resolveAutoCandidates({
      cwd: tmp,
      env: {}, // no api key
      lastUserMessage: "please review this function",
    });
    // viability dropped them; localFast remains viable
    expect(r.candidateIds).toEqual(["localFast"]);
  });

  it("when ALL candidates are non-viable, keeps them so the caller sees an informative error", async () => {
    // Use a config with only a remote profile + no key.
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          claudeOnly: { kind: "private-remote", provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [] },
        },
        routingPolicy: { autoEscalationCeiling: "public-cloud" },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
      }),
    );
    const r = await resolveAutoCandidates({ cwd: tmp, env: {}, lastUserMessage: "review code" });
    expect(r.candidateIds).toEqual(["claudeOnly"]); // non-viable but kept (informative error path)
  });

  it("returns empty list when no profiles exist at all", async () => {
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {},
        routingPolicy: { autoEscalationCeiling: "public-cloud" },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
      }),
    );
    const r = await resolveAutoCandidates({ cwd: tmp, env: {}, lastUserMessage: "x" });
    expect(r.candidateIds).toEqual([]);
  });
});
