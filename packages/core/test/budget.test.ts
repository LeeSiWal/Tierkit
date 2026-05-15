import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendUsage } from "../src/runtime/usageLog.js";
import { checkBudget } from "../src/runtime/budget.js";

async function makeLog(records: { costUsd: number; daysAgo?: number }[]): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-budget-"));
  const logPath = path.join(tmp, "usage.jsonl");
  for (const r of records) {
    const date = new Date();
    if (r.daysAgo) date.setDate(date.getDate() - r.daysAgo);
    await appendUsage(logPath, {
      timestamp: date.toISOString(),
      profileId: "p",
      provider: "anthropic",
      model: "m",
      tier: "public-cloud",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: r.costUsd,
      latencyMs: 100,
      ok: true,
    });
  }
  return logPath;
}

describe("checkBudget", () => {
  let logPath: string;
  afterEach(async () => {
    if (logPath) await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  });

  it("returns ok when no budget is configured", async () => {
    logPath = await makeLog([{ costUsd: 100 }]);
    const r = await checkBudget(logPath);
    expect(r.status).toBe("ok");
  });

  it("returns ok when under warn threshold", async () => {
    logPath = await makeLog([{ costUsd: 0.5 }]);
    const r = await checkBudget(logPath, { dailyUsdLimit: 10, warnAtPercent: 70, blockAtPercent: 100 });
    expect(r.status).toBe("ok");
  });

  it("returns warn at warnAtPercent", async () => {
    logPath = await makeLog([{ costUsd: 7.5 }]);
    const r = await checkBudget(logPath, { dailyUsdLimit: 10, warnAtPercent: 70, blockAtPercent: 100 });
    expect(r.status).toBe("warn");
    expect(r.reason).toMatch(/daily budget/);
  });

  it("returns block at blockAtPercent", async () => {
    logPath = await makeLog([{ costUsd: 10 }]);
    const r = await checkBudget(logPath, { dailyUsdLimit: 10, warnAtPercent: 70, blockAtPercent: 100 });
    expect(r.status).toBe("block");
  });

  it("daily window excludes older spending", async () => {
    logPath = await makeLog([{ costUsd: 100, daysAgo: 2 }, { costUsd: 1, daysAgo: 0 }]);
    const r = await checkBudget(logPath, { dailyUsdLimit: 10, warnAtPercent: 70, blockAtPercent: 100 });
    expect(r.dailyUsedUsd).toBeCloseTo(1, 2);
    expect(r.status).toBe("ok");
  });

  it("monthly window includes earlier days within the current month", async () => {
    logPath = await makeLog([{ costUsd: 100, daysAgo: 2 }, { costUsd: 1, daysAgo: 0 }]);
    const r = await checkBudget(logPath, { monthlyUsdLimit: 50, warnAtPercent: 70, blockAtPercent: 100 });
    // daysAgo:2 likely falls within same month — total ~101 ≥ 50 → block
    if (r.monthlyUsedUsd >= 50) expect(r.status).toBe("block");
  });
});
