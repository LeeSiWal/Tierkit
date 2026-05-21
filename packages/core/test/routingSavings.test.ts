import { describe, it, expect } from "vitest";
import { computeRoutingSavings } from "../src/runtime/routingSavings.js";
import type { UsageRecord } from "../src/runtime/usageLog.js";
import type { ModelProfile } from "../src/model/ModelProfile.js";

const baseline = {
  kind: "public-cloud",
  paymentModel: "per-token",
  provider: "anthropic",
  model: "claude-sonnet",
  displayName: "Claude Sonnet (baseline)",
  roles: ["code", "review"],
  requiresApproval: true,
  cost: {
    type: "per-token",
    inputUsdPerMillion: 3,   // $3 per 1M input tokens
    outputUsdPerMillion: 15, // $15 per 1M output tokens
  },
} as unknown as ModelProfile;

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestamp: new Date().toISOString(),
    profileId: "localCoder",
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    tier: "local-device",
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0,
    latencyMs: 1000,
    ok: true,
    ...over,
  };
}

describe("computeRoutingSavings", () => {
  it("sums input + output tokens from local-device successful calls only", () => {
    const records: UsageRecord[] = [
      rec({ inputTokens: 1000, outputTokens: 200 }),
      rec({ inputTokens: 500, outputTokens: 100 }),
      // Cloud call — should NOT count as savings.
      rec({ tier: "public-cloud", inputTokens: 999 }),
      // Failed local call — should NOT count.
      rec({ ok: false, failureCode: "unreachable" }),
    ];
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const result = computeRoutingSavings(records, baseline, since);
    expect(result.inputTokensRouted).toBe(1500);
    expect(result.outputTokensRouted).toBe(300);
    expect(result.cloudCallsAvoided).toBe(2);
  });

  it("filters out type:'mcp-tool' records (heterogeneous usage.jsonl)", () => {
    const records: unknown[] = [
      rec({ inputTokens: 1000, outputTokens: 200 }),
      // MCP-tool record has no tier/inputTokens; type discriminator separates it.
      { type: "mcp-tool", tool: "tierkit.read_file", ok: true, durationMs: 12, ts: new Date().toISOString() },
    ];
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const result = computeRoutingSavings(records as UsageRecord[], baseline, since);
    expect(result.cloudCallsAvoided).toBe(1);
    expect(result.inputTokensRouted).toBe(1000);
  });

  it("respects the since cutoff", () => {
    const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    const today = new Date().toISOString();
    const records: UsageRecord[] = [
      rec({ timestamp: yesterday, inputTokens: 9999 }),  // older than 24h — excluded
      rec({ timestamp: today, inputTokens: 100 }),
    ];
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const result = computeRoutingSavings(records, baseline, since);
    expect(result.inputTokensRouted).toBe(100);
    expect(result.cloudCallsAvoided).toBe(1);
  });

  it("uses estimateCost(baseline, sumInput, sumOutput) for estimatedCostSaved", () => {
    const records: UsageRecord[] = [
      rec({ inputTokens: 1_000_000, outputTokens: 200_000 }),
    ];
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const result = computeRoutingSavings(records, baseline, since);
    // baseline: $3/M input + $15/M output → 3 + 3 = $6
    expect(result.estimatedCostSaved).toBeCloseTo(6, 2);
  });

  it("skips records with missing/NaN inputTokens defensively", () => {
    const records: unknown[] = [
      rec({ inputTokens: 1000 }),
      { ...rec(), inputTokens: undefined },     // partial / corrupt
      { ...rec(), inputTokens: NaN },
    ];
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const result = computeRoutingSavings(records as UsageRecord[], baseline, since);
    expect(result.inputTokensRouted).toBe(1000);
    expect(result.cloudCallsAvoided).toBe(1);
  });

  it("baseline display fields are populated", () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const result = computeRoutingSavings([], baseline, since);
    expect(result.baselineProfileId).toBe("claude-sonnet");
    expect(result.baselineDisplayName).toBe("Claude Sonnet (baseline)");
  });
});
