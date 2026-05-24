import { describe, it, expect } from "vitest";
import { resolveSavingsBaseline } from "../src/runtime/tierkitSavings.js";
import type { TierkitConfig } from "../src/config/TierkitConfig.js";

const cfg = (profiles: Record<string, any>, baseline?: string): TierkitConfig =>
  ({ modelProfiles: profiles, routingBaseline: baseline } as unknown as TierkitConfig);

describe("resolveSavingsBaseline", () => {
  it("uses routingBaseline when it has per-token cost", () => {
    const out = resolveSavingsBaseline(cfg({
      claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
    }, "claudeSonnet"));
    expect(out.baselineId).toBe("claudeSonnet");
    expect(out.inputUsdPerMillion).toBe(3);
  });

  it("falls back to a same-family priced profile when baseline is flat-rate", () => {
    const out = resolveSavingsBaseline(cfg({
      claudeCode: { provider: "claude-code", cost: { type: "flat", monthlyUsd: 20 } },
      claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
      gpt4o: { provider: "openai", cost: { type: "per-token", inputUsdPerMillion: 5, outputUsdPerMillion: 15 } },
    }, "claudeCode"));
    expect(out.baselineId).toBe("claudeSonnet");
    expect(out.inputUsdPerMillion).toBe(3);
  });

  it("returns inputUsdPerMillion=undefined when no priced profile exists", () => {
    const out = resolveSavingsBaseline(cfg({
      localCoder: { provider: "ollama", cost: { type: "free" } },
    }, "localCoder"));
    expect(out.baselineId).toBe("localCoder");
    expect(out.inputUsdPerMillion).toBeUndefined();
  });

  it("defaults to claudeCode baseline when routingBaseline is unset", () => {
    const out = resolveSavingsBaseline(cfg({
      claudeCode: { provider: "claude-code" },
      claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
    }));
    expect(out.baselineId).toBe("claudeSonnet"); // falls back from default claudeCode
  });
});
