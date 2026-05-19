import { describe, expect, it } from "vitest";
import { aggregateByProfile, type UsageRecord } from "@tierkit/core";

const rec = (profileId: string, when: string, over: Partial<UsageRecord> = {}): UsageRecord => ({
  timestamp: when,
  profileId,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  tier: "public-cloud",
  inputTokens: 1000,
  outputTokens: 200,
  costUsd: 0.01,
  latencyMs: 100,
  ok: true,
  ...over,
});

describe("aggregateByProfile", () => {
  it("returns empty object when log is empty", () => {
    expect(aggregateByProfile([], new Date("2026-05-19T00:00:00Z"))).toEqual({});
  });

  it("groups today + month per profile with zero defaults for absent categories", () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const records: UsageRecord[] = [
      // claudeSonnet — earlier this month (not today)
      rec("claudeSonnet", "2026-05-10T08:00:00Z", { inputTokens: 5000, outputTokens: 800, costUsd: 0.50 }),
      // claudeSonnet — today
      rec("claudeSonnet", "2026-05-19T09:00:00Z", { inputTokens: 1200, outputTokens: 300, costUsd: 0.12 }),
      // claudeHaiku — today
      rec("claudeHaiku", "2026-05-19T10:00:00Z", { inputTokens: 800, outputTokens: 100, costUsd: 0.02 }),
      // gpt4o — last month (must NOT count)
      rec("gpt4o", "2026-04-30T08:00:00Z", { inputTokens: 9999, costUsd: 9.99 }),
    ];
    const r = aggregateByProfile(records, now);
    expect(r.claudeSonnet?.today).toEqual({
      calls: 1, inputTokens: 1200, outputTokens: 300, costUsd: 0.12,
    });
    expect(r.claudeSonnet?.month).toEqual({
      calls: 2, inputTokens: 6200, outputTokens: 1100, costUsd: 0.62,
    });
    expect(r.claudeHaiku?.today).toEqual({
      calls: 1, inputTokens: 800, outputTokens: 100, costUsd: 0.02,
    });
    expect(r.claudeHaiku?.month).toEqual({
      calls: 1, inputTokens: 800, outputTokens: 100, costUsd: 0.02,
    });
    expect(r.gpt4o).toBeUndefined();  // last month — excluded
  });

  it("excludes records where ok === false (failed calls don't count toward budget)", () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const r = aggregateByProfile(
      [
        rec("claudeSonnet", "2026-05-19T08:00:00Z", { ok: false }),
        rec("claudeSonnet", "2026-05-19T09:00:00Z", { inputTokens: 500, costUsd: 0.01 }),
      ],
      now,
    );
    expect(r.claudeSonnet?.today.calls).toBe(1);
    expect(r.claudeSonnet?.today.inputTokens).toBe(500);
  });

  it("yields the same shape for today and month even when month has no data", () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const r = aggregateByProfile(
      [rec("claudeSonnet", "2026-05-19T08:00:00Z")],
      now,
    );
    expect(r.claudeSonnet?.today).toBeDefined();
    expect(r.claudeSonnet?.month).toBeDefined();
    expect(typeof r.claudeSonnet?.today.calls).toBe("number");
    expect(typeof r.claudeSonnet?.month.calls).toBe("number");
  });
});
