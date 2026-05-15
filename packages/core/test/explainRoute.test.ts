import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { explainRoute } from "../src/usecases/explainRoute.js";

const baseConfig = {
  version: "0.1",
  defaultTarget: "generic",
  modelProfiles: {
    localFast: { kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b" },
    localStrong: { kind: "local-device", provider: "ollama", model: "qwen2.5-coder:32b" },
    privateRemoteStrong: {
      kind: "private-remote",
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      model: "qwen-coder-72b",
      apiKeyEnv: "K",
    },
    publicCloudPremium: {
      kind: "public-cloud",
      provider: "anthropic",
      model: "claude-sonnet",
      apiKeyEnv: "AK",
      requiresApproval: true,
      defaultMode: "review-only",
    },
  },
};

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-explainroute-"));
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(baseConfig));
  return root;
}

describe("explainRoute", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("routes a trivial task to local-device", async () => {
    root = await makeRoot();
    const r = await explainRoute({ cwd: root, task: "rename a variable" });
    expect(r.decision.tier).toBe("local-device");
    expect(r.profile).toBeDefined();
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it("escalates to public-cloud for production-touching tasks", async () => {
    root = await makeRoot();
    const r = await explainRoute({
      cwd: root,
      task: "audit the production secret rotation in the auth service",
      filesTouchedEstimate: 12,
      involvesProductionInfra: true,
      involvesSecrets: true,
    });
    expect(r.decision.tier).toBe("public-cloud");
    expect(r.decision.requiresApproval).toBe(true);
    expect(r.decision.mode).toBe("review-only");
  });

  it("emits at least one reason describing the score", async () => {
    root = await makeRoot();
    const r = await explainRoute({ cwd: root, task: "refactor the database schema" });
    expect(r.decision.reasons.length).toBeGreaterThan(0);
  });
});
