import { describe, it, expect } from "vitest";
import { decideRoute } from "../src/model/ModelRouter.js";
import type { ModelProfileMap } from "../src/model/ModelProfile.js";

const profiles: ModelProfileMap = {
  localFast:    { kind: "local-device",   provider: "ollama", model: "llama3:3b", roles: [] },
  localCoder:   { kind: "local-device",   provider: "ollama", model: "qwen:7b",   roles: [], goodAt: ["code-generation"] },
  claudeHaiku:  { kind: "private-remote", provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [] },
  claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6",         apiKeyEnv: "ANTHROPIC_API_KEY", roles: [], goodAt: ["code-review", "plan"] },
  gpt4o:        { kind: "public-cloud",   provider: "openai", model: "gpt-4o",      apiKeyEnv: "OPENAI_API_KEY", roles: [], requiresApproval: true },
  gpt4oMini:    { kind: "public-cloud",   provider: "openai", model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY", roles: [], requiresApproval: true },
};

describe("decideRoute escalationChain", () => {
  it("builds a chain that starts with the primary tier", () => {
    const r = decideRoute({
      task: { task: "write a function" }, // low risk → local-fast tier
      profiles,
    });
    expect(r.escalationChain.length).toBeGreaterThan(0);
    expect(r.escalationChain[0]!.tier).toBe("local-device");
    expect(r.escalationChain[0]!.isEscalation).toBe(false);
  });

  it("appends higher tiers after primary, with isEscalation=true", () => {
    const r = decideRoute({
      task: { task: "write a function" },
      profiles,
      ceiling: "public-cloud",
    });
    const tiers = r.escalationChain.map((c) => c.tier);
    const localIdx = tiers.indexOf("local-device");
    const privateIdx = tiers.indexOf("private-remote");
    const publicIdx = tiers.indexOf("public-cloud");
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(privateIdx).toBeGreaterThan(localIdx);
    expect(publicIdx).toBeGreaterThan(privateIdx);

    for (const c of r.escalationChain.filter((c) => c.tier !== r.tier)) {
      expect(c.isEscalation).toBe(true);
    }
  });

  it("respects ceiling = 'private-remote' (no public-cloud in chain)", () => {
    const r = decideRoute({
      task: { task: "write a function" },
      profiles,
      ceiling: "private-remote",
    });
    expect(r.escalationChain.some((c) => c.tier === "public-cloud")).toBe(false);
  });

  it("respects ceiling = 'local-device' (chain stays in primary tier)", () => {
    const r = decideRoute({
      task: { task: "write a function" },
      profiles,
      ceiling: "local-device",
    });
    expect(r.escalationChain.every((c) => c.tier === "local-device")).toBe(true);
  });

  it("within a tier, sorts goodAt-matched profiles first for the given taskType", () => {
    const r = decideRoute({
      task: { task: "review my code" }, // taskType=code-review
      profiles,
      ceiling: "public-cloud",
      taskType: "code-review",
    });
    const privateRemoteIds = r.escalationChain.filter((c) => c.tier === "private-remote").map((c) => c.id);
    expect(privateRemoteIds[0]).toBe("claudeSonnet"); // has goodAt:["code-review"]
    expect(privateRemoteIds).toContain("claudeHaiku");
    expect(privateRemoteIds.indexOf("claudeSonnet")).toBeLessThan(privateRemoteIds.indexOf("claudeHaiku"));
  });

  it("for unrelated taskType, neutral profiles come BEFORE anti-fit profiles", () => {
    const r = decideRoute({
      task: { task: "translate something" }, // taskType=translate
      profiles,
      taskType: "translate",
      ceiling: "public-cloud",
    });
    const localIds = r.escalationChain.filter((c) => c.tier === "local-device").map((c) => c.id);
    // localFast has no goodAt (neutral); localCoder has goodAt:['code-generation'] (anti-fit for translate)
    expect(localIds.indexOf("localFast")).toBeLessThan(localIds.indexOf("localCoder"));
  });
});
