import type { z } from "zod";
import type { BudgetPolicySchema } from "../config/TierkitConfig.js";
import { readUsage, summarizeUsage } from "./usageLog.js";

export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export type BudgetStatus = "ok" | "warn" | "block";

export interface BudgetCheckResult {
  status: BudgetStatus;
  dailyUsedUsd: number;
  monthlyUsedUsd: number;
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  /** Human-readable reason when status is warn/block. */
  reason?: string;
}

/**
 * Compare current usage against the configured budget. Returns:
 * - `ok`    — well under limits (no warning threshold reached)
 * - `warn`  — past `warnAtPercent` of at least one limit
 * - `block` — past `blockAtPercent` of at least one limit; the runtime should reject the request
 *
 * If `budget` is undefined (no limits configured), always returns `ok`.
 */
export async function checkBudget(usageLogPath: string, budget?: BudgetPolicy): Promise<BudgetCheckResult> {
  const records = await readUsage(usageLogPath);
  const now = Date.now();

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const dayUsage = summarizeUsage(records, dayStart);
  const monthUsage = summarizeUsage(records, monthStart);

  const result: BudgetCheckResult = {
    status: "ok",
    dailyUsedUsd: dayUsage.totalCostUsd,
    monthlyUsedUsd: monthUsage.totalCostUsd,
  };
  if (budget?.dailyUsdLimit !== undefined) result.dailyLimitUsd = budget.dailyUsdLimit;
  if (budget?.monthlyUsdLimit !== undefined) result.monthlyLimitUsd = budget.monthlyUsdLimit;

  if (!budget) return result;

  const warnPct = budget.warnAtPercent / 100;
  const blockPct = budget.blockAtPercent / 100;

  const checkLimit = (used: number, limit: number | undefined, label: string): void => {
    if (limit === undefined || limit <= 0) return;
    if (used >= limit * blockPct) {
      result.status = "block";
      result.reason = `${label} budget reached ${pct(used, limit)}% (used $${used.toFixed(4)} / $${limit})`;
    } else if (used >= limit * warnPct && result.status !== "block") {
      result.status = "warn";
      result.reason = `${label} budget at ${pct(used, limit)}% (used $${used.toFixed(4)} / $${limit})`;
    }
  };

  checkLimit(dayUsage.totalCostUsd, budget.dailyUsdLimit, "daily");
  checkLimit(monthUsage.totalCostUsd, budget.monthlyUsdLimit, "monthly");

  return result;
}

function pct(used: number, limit: number): string {
  if (limit <= 0) return "0";
  return ((used / limit) * 100).toFixed(0);
}
