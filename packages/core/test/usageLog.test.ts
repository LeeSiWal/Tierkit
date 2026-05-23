import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendUsage,
  readUsage,
  summarizeUsage,
  aggregateByProfile,
  estimateCost,
  type UsageRecord,
} from "../src/runtime/usageLog.js";
import type { ModelProfile } from "../src/model/ModelProfile.js";

describe("usageLog", () => {
  let tmp: string;
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("appends records line-by-line and reads them back", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usage-"));
    const logPath = path.join(tmp, "usage.jsonl");
    const rec: UsageRecord = {
      timestamp: new Date().toISOString(),
      profileId: "localFast",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      tier: "local-device",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0,
      latencyMs: 200,
      ok: true,
    };
    await appendUsage(logPath, rec);
    await appendUsage(logPath, { ...rec, inputTokens: 200 });
    const records = await readUsage(logPath);
    expect(records).toHaveLength(2);
    expect(records[0]?.inputTokens).toBe(100);
    expect(records[1]?.inputTokens).toBe(200);
  });

  it("returns [] when log file does not exist", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usage-empty-"));
    const r = await readUsage(path.join(tmp, "nope.jsonl"));
    expect(r).toEqual([]);
  });

  it("ignores malformed lines", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usage-corrupt-"));
    const logPath = path.join(tmp, "usage.jsonl");
    await fs.writeFile(logPath, '{"ok":true,"profileId":"p","provider":"ollama","model":"m","tier":"local-device","inputTokens":1,"outputTokens":1,"costUsd":0,"latencyMs":10,"timestamp":"2026-05-15T00:00:00.000Z"}\nthis is not json\n');
    const r = await readUsage(logPath);
    expect(r).toHaveLength(1);
  });

  // Regression: usage.jsonl intentionally co-stores LlmCall records AND
  // mcp-tool records (see trimUsageLog docstring). MCP-tool entries use `ts`,
  // not `timestamp`, and lack profileId/inputTokens. readUsage's typed return
  // is UsageRecord[], so it must drop foreign shapes — otherwise downstream
  // consumers (aggregateByProfile, summarizeUsage) crash on `r.timestamp.startsWith`.
  it("drops mcp-tool records and other non-LlmCall shapes", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usage-hetero-"));
    const logPath = path.join(tmp, "usage.jsonl");
    const llm = '{"timestamp":"2026-05-15T00:00:00.000Z","profileId":"localFast","provider":"ollama","model":"m","tier":"local-device","inputTokens":1,"outputTokens":1,"costUsd":0,"latencyMs":10,"ok":true}';
    const mcp = '{"ts":"2026-05-22T20:36:07.665Z","type":"mcp-tool","workspaceRoot":"/w","tool":"tierkit.get_file_digest","ok":true,"durationMs":7,"outputSummary":{"beforeTokens":22615,"afterTokens":600,"savedTokens":22015}}';
    await fs.writeFile(logPath, `${llm}\n${mcp}\n${llm}\n`);
    const r = await readUsage(logPath);
    expect(r).toHaveLength(2);
    expect(r.every((x) => typeof x.timestamp === "string")).toBe(true);
    expect(r.every((x) => typeof x.profileId === "string")).toBe(true);
  });

  it("aggregateByProfile does not crash when log has mcp-tool entries", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usage-agg-"));
    const logPath = path.join(tmp, "usage.jsonl");
    const llm = '{"timestamp":"2026-05-24T00:00:00.000Z","profileId":"localFast","provider":"ollama","model":"m","tier":"local-device","inputTokens":1,"outputTokens":1,"costUsd":0,"latencyMs":10,"ok":true}';
    const mcp = '{"ts":"2026-05-22T20:36:07.665Z","type":"mcp-tool","tool":"tierkit.get_file_digest","ok":true}';
    await fs.writeFile(logPath, `${mcp}\n${llm}\n`);
    const records = await readUsage(logPath);
    expect(() => aggregateByProfile(records, new Date("2026-05-24T12:00:00Z"))).not.toThrow();
  });

  it("summarizes by profile + totals", async () => {
    const now = Date.now();
    const records: UsageRecord[] = [
      {
        timestamp: new Date(now).toISOString(),
        profileId: "localFast",
        provider: "ollama",
        model: "x",
        tier: "local-device",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0,
        latencyMs: 10,
        ok: true,
      },
      {
        timestamp: new Date(now).toISOString(),
        profileId: "cloud",
        provider: "anthropic",
        model: "claude-sonnet",
        tier: "public-cloud",
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 0.012,
        latencyMs: 800,
        ok: true,
      },
      {
        timestamp: new Date(now).toISOString(),
        profileId: "cloud",
        provider: "anthropic",
        model: "claude-sonnet",
        tier: "public-cloud",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 200,
        ok: false,
        failureCode: "unauthorized",
      },
    ];
    const s = summarizeUsage(records);
    expect(s.totalCalls).toBe(3);
    expect(s.successfulCalls).toBe(2);
    expect(s.failedCalls).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(0.012, 5);
    expect(s.byProfile.get("cloud")?.calls).toBe(2);
    expect(s.byProfile.get("localFast")?.calls).toBe(1);
  });

  it("respects the `since` cutoff", async () => {
    const records: UsageRecord[] = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        profileId: "p",
        provider: "ollama",
        model: "m",
        tier: "local-device",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        ok: true,
      },
      {
        timestamp: "2026-06-01T00:00:00.000Z",
        profileId: "p",
        provider: "ollama",
        model: "m",
        tier: "local-device",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        ok: true,
      },
    ];
    const s = summarizeUsage(records, new Date("2026-05-01T00:00:00Z"));
    expect(s.totalCalls).toBe(1);
  });
});

describe("estimateCost", () => {
  const baseProfile: ModelProfile = {
    kind: "public-cloud",
    provider: "anthropic",
    model: "claude-sonnet",
    apiKeyEnv: "AK",
    requiresApproval: true,
    defaultMode: "review-only",
    roles: [],
  };

  it("returns 0 for free cost", () => {
    expect(estimateCost({ ...baseProfile, cost: { type: "free" } }, 1000, 500)).toBe(0);
  });

  it("returns 0 for missing cost field", () => {
    expect(estimateCost(baseProfile, 1000, 500)).toBe(0);
  });

  it("calculates per-token cost", () => {
    const cost = estimateCost(
      { ...baseProfile, cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
      1_000_000,
      1_000_000,
    );
    expect(cost).toBeCloseTo(18, 5);
  });

  it("ignores flat cost (handled at month boundary)", () => {
    expect(estimateCost({ ...baseProfile, cost: { type: "flat", monthlyUsd: 20 } }, 1000, 500)).toBe(0);
  });
});
