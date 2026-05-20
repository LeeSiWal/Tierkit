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

  it("appends lower tiers as tail fallback when primary is private-remote (so no-API-key fall back to local)", () => {
    // High-risk task → primary=private-remote. Without the tail-fallback,
    // viability prune (in autoResolver) would return only Anthropic profiles
    // and a missing ANTHROPIC_API_KEY surfaces as dead-end error.
    const r = decideRoute({
      task: { task: "production deploy review" }, // production+deploy → score 55 → private-remote
      profiles,
      ceiling: "private-remote",
      taskType: "code-review",
    });
    expect(r.tier).toBe("private-remote");
    const tiers = r.escalationChain.map((c) => c.tier);
    // private-remote should come first, local-device LAST (tail fallback)
    expect(tiers[0]).toBe("private-remote");
    expect(tiers).toContain("local-device");
    expect(tiers.lastIndexOf("local-device")).toBeGreaterThan(tiers.indexOf("private-remote"));
    // Tail entries should be marked as escalation (semantically: "we're stepping outside the primary tier")
    for (const c of r.escalationChain.filter((c) => c.tier === "local-device")) {
      expect(c.isEscalation).toBe(true);
    }
  });

  it("tail fallback adds BOTH private-remote and local-device when primary=public-cloud", () => {
    // Force public-cloud via custom thresholds so this stays a router-logic test
    // (independent of the risk-scorer's keyword weights).
    const r = decideRoute({
      task: { task: "write a function" },
      profiles,
      ceiling: "public-cloud",
      thresholds: { localFastMax: 0, localStrongMax: 0, privateRemoteMax: 0, publicCloudReviewMin: 1 },
    });
    expect(r.tier).toBe("public-cloud");
    const tiers = r.escalationChain.map((c) => c.tier);
    // Order: public-cloud first, then private-remote, then local-device
    expect(tiers[0]).toBe("public-cloud");
    expect(tiers).toContain("private-remote");
    expect(tiers).toContain("local-device");
    const publicLast = tiers.lastIndexOf("public-cloud");
    const privateFirst = tiers.indexOf("private-remote");
    const localFirst = tiers.indexOf("local-device");
    expect(privateFirst).toBeGreaterThan(publicLast);
    expect(localFirst).toBeGreaterThan(privateFirst);
  });

  it("no double-inclusion: each profile appears at most once in the chain", () => {
    const r = decideRoute({
      task: { task: "review my code" },
      profiles,
      ceiling: "private-remote",
      taskType: "code-review",
    });
    const ids = r.escalationChain.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
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
