import { describe, it, expect } from "vitest";
import { buildEscalationChain } from "../src/model/ModelRouter.js";
import type { ModelProfileMap } from "../src/model/ModelProfile.js";

const baseRemote = { kind: "private-remote" as const, provider: "x", model: "x", roles: [] };
const subprocessTransport = {
  type: "subprocess" as const,
  command: "claude",
  args: [],
  healthCheckArgs: ["--version"],
  timeoutMs: 1, maxStdoutBytes: 1, maxStderrBytes: 1,
};

describe("sortProfilesForTier — paymentModel primary key", () => {
  it("orders flat-rate before per-token within the same tier", () => {
    const profiles: ModelProfileMap = {
      perTokenA: { ...baseRemote, paymentModel: "per-token", provider: "anthropic", apiKeyEnv: "X" },
      flatRateA: { ...baseRemote, paymentModel: "flat-rate", provider: "claude-code", transport: subprocessTransport },
    };
    const chain = buildEscalationChain(profiles, "private-remote", "public-cloud", "general");
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf("flatRateA")).toBeLessThan(ids.indexOf("perTokenA"));
  });

  it("goodAt match overrides paymentModel within the same paymentModel rank", () => {
    const profiles: ModelProfileMap = {
      flatNeutral: { ...baseRemote, paymentModel: "flat-rate", provider: "claude-code", transport: subprocessTransport },
      flatFit: { ...baseRemote, paymentModel: "flat-rate", provider: "claude-code",
                 goodAt: ["code-review"], transport: subprocessTransport },
    };
    const chain = buildEscalationChain(profiles, "private-remote", "public-cloud", "code-review");
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf("flatFit")).toBeLessThan(ids.indexOf("flatNeutral"));
  });

  it("flat-rate beats a goodAt-fit per-token profile", () => {
    const profiles: ModelProfileMap = {
      perTokenFit: { ...baseRemote, paymentModel: "per-token", provider: "anthropic", apiKeyEnv: "X", goodAt: ["code-review"] },
      flatNeutral: { ...baseRemote, paymentModel: "flat-rate", provider: "claude-code", transport: subprocessTransport },
    };
    const chain = buildEscalationChain(profiles, "private-remote", "public-cloud", "code-review");
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf("flatNeutral")).toBeLessThan(ids.indexOf("perTokenFit"));
  });

  it("declaration order is the final tie-breaker", () => {
    const profiles: ModelProfileMap = {
      flatA: { ...baseRemote, paymentModel: "flat-rate", provider: "claude-code", transport: subprocessTransport },
      flatB: { ...baseRemote, paymentModel: "flat-rate", provider: "claude-code", transport: subprocessTransport },
    };
    const chain = buildEscalationChain(profiles, "private-remote", "public-cloud", "general");
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf("flatA")).toBeLessThan(ids.indexOf("flatB"));
  });
});
