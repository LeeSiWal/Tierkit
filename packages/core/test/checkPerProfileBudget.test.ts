import { describe, expect, it } from "vitest";
import {
  checkPerProfileBudget,
  type ModelProfile,
} from "@tierkit/core";

// Minimal helper to build a usage-aggregate object the way the gate consumes it.
const usage = (over: Partial<{ todayInputTokens: number; todayCostUsd: number; monthInputTokens: number; monthCostUsd: number }> = {}) => ({
  today: { inputTokens: over.todayInputTokens ?? 0, costUsd: over.todayCostUsd ?? 0 },
  month: { inputTokens: over.monthInputTokens ?? 0, costUsd: over.monthCostUsd ?? 0 },
});

const perToken = (over: Partial<ModelProfile> = {}): ModelProfile => ({
  kind: "public-cloud",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  roles: [],
  requiresApproval: true,
  cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  ...over,
});

const flatRate = (over: Partial<ModelProfile> = {}): ModelProfile => ({
  kind: "public-cloud",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  roles: [],
  requiresApproval: true,
  paymentModel: "flat-rate",
  ...over,
});

const free = (over: Partial<ModelProfile> = {}): ModelProfile => ({
  kind: "local-device",
  provider: "ollama",
  model: "qwen2.5-coder:7b",
  roles: [],
  ...over,
});

describe("checkPerProfileBudget — per-token", () => {
  it("ok when usage is 30% of monthly USD cap", () => {
    const result = checkPerProfileBudget({
      profile: perToken(),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 6, monthInputTokens: 2_000_000 }),
      budget: { monthlyUsdLimit: 20 },
    });
    expect(result).toBe("ok");
  });

  it("ok at exactly the cap (at-limit allowed)", () => {
    // monthCostUsd is already $19.997, plus an estimated $0.003 from 1000 tokens
    // at $3/1M → arrives exactly at $20. `>` comparison: NOT blocked.
    const result = checkPerProfileBudget({
      profile: perToken(),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 19.997 }),
      budget: { monthlyUsdLimit: 20 },
    });
    expect(result).toBe("ok");
  });

  it("blocked when monthly USD cap would be exceeded", () => {
    const result = checkPerProfileBudget({
      profile: perToken(),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 19.999 }),
      budget: { monthlyUsdLimit: 20 },
    });
    expect(result).not.toBe("ok");
    if (result !== "ok") {
      expect(result.reason).toContain("monthly USD cap");
    }
  });

  it("blocked when monthly input token cap would be exceeded", () => {
    const result = checkPerProfileBudget({
      profile: perToken(),
      estimatedInputTokens: 1000,
      usage: usage({ monthInputTokens: 199_500 }),
      budget: { monthlyInputTokenLimit: 200_000 },
    });
    expect(result).not.toBe("ok");
    if (result !== "ok") {
      expect(result.reason).toContain("monthly input token cap");
    }
  });

  it("tokens checked before USD when both would block (algorithm order)", () => {
    const result = checkPerProfileBudget({
      profile: perToken(),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 19.999, monthInputTokens: 199_500 }),
      budget: { monthlyUsdLimit: 20, monthlyInputTokenLimit: 200_000 },
    });
    expect(result).not.toBe("ok");
    if (result !== "ok") {
      expect(result.reason).toContain("monthly input token cap");
    }
  });

  it("blocked when daily USD cap would be exceeded", () => {
    const result = checkPerProfileBudget({
      profile: perToken(),
      estimatedInputTokens: 1000,
      usage: usage({ todayCostUsd: 4.999 }),
      budget: { dailyUsdLimit: 5 },
    });
    expect(result).not.toBe("ok");
    if (result !== "ok") {
      expect(result.reason).toContain("daily USD cap");
    }
  });

  it("USD check skipped silently when profile has no cost data", () => {
    const result = checkPerProfileBudget({
      profile: perToken({ cost: undefined }),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 1000 }),
      budget: { monthlyUsdLimit: 20 },
    });
    expect(result).toBe("ok");
  });
});

describe("checkPerProfileBudget — flat-rate (USD not enforced, tokens enforced)", () => {
  it("ok even when USD usage is over the cap", () => {
    const result = checkPerProfileBudget({
      profile: flatRate(),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 9999 }),
      budget: { monthlyUsdLimit: 20 },
    });
    expect(result).toBe("ok");
  });

  it("blocked when monthly input token cap is exceeded", () => {
    const result = checkPerProfileBudget({
      profile: flatRate(),
      estimatedInputTokens: 1000,
      usage: usage({ monthInputTokens: 199_500 }),
      budget: { monthlyInputTokenLimit: 200_000 },
    });
    expect(result).not.toBe("ok");
    if (result !== "ok") {
      expect(result.reason).toContain("monthly input token cap");
    }
  });
});

describe("checkPerProfileBudget — free (USD ignored, tokens enforced)", () => {
  it("ok even when USD usage is over the cap", () => {
    const result = checkPerProfileBudget({
      profile: free(),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 9999 }),
      budget: { monthlyUsdLimit: 20 },
    });
    expect(result).toBe("ok");
  });

  it("blocked when monthly input token cap is exceeded", () => {
    const result = checkPerProfileBudget({
      profile: free(),
      estimatedInputTokens: 1000,
      usage: usage({ monthInputTokens: 199_500 }),
      budget: { monthlyInputTokenLimit: 200_000 },
    });
    expect(result).not.toBe("ok");
    if (result !== "ok") {
      expect(result.reason).toContain("monthly input token cap");
    }
  });
});

describe("checkPerProfileBudget — no caps set", () => {
  it("ok when budget is empty regardless of usage", () => {
    const result = checkPerProfileBudget({
      profile: perToken(),
      estimatedInputTokens: 1000,
      usage: usage({ monthCostUsd: 9999, monthInputTokens: 999_999 }),
      budget: {},
    });
    expect(result).toBe("ok");
  });
});
