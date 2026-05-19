import { effectivePaymentModel, type ModelProfile } from "../model/ModelProfile.js";
import type { PerProfileBudget } from "../config/TierkitConfig.js";

/**
 * Per-profile usage snapshot as the budget gate consumes it. Built by the
 * caller (Server.ts / runRoute) from the existing usage log via the
 * aggregator added in Task 5 (/v1/usage profiles field).
 */
export interface ProfileUsageSnapshot {
  today: { inputTokens: number; costUsd: number };
  month: { inputTokens: number; costUsd: number };
}

export interface CheckPerProfileBudgetInput {
  profile: ModelProfile;
  /** Estimated input tokens for the request being checked (post-redact). */
  estimatedInputTokens: number;
  usage: ProfileUsageSnapshot;
  budget: PerProfileBudget;
}

export type CheckPerProfileBudgetResult =
  | "ok"
  | { blocked: true; reason: string };

/**
 * Decide whether a single per-profile call should be allowed under the
 * profile's budget caps. Pure function — no I/O.
 *
 * Semantics:
 *   - Boundary: `>` comparison; at-limit allowed, over-limit blocked.
 *   - USD pre-call estimate uses input tokens only (output unknown).
 *     Post-call usage is recorded with both input + output by the existing
 *     usageLog.append() path; the next call's check uses the accumulated
 *     actual cost.
 *   - Per paymentModel:
 *       per-token: USD + input-token caps both enforced.
 *       flat-rate: only input-token caps enforced (USD is display-only).
 *       free:      only input-token caps enforced (USD is ignored).
 *   - Check order: daily input tokens → monthly input tokens → daily USD →
 *     monthly USD. Whichever blocks first wins the "reason" string.
 */
export function checkPerProfileBudget(
  input: CheckPerProfileBudgetInput,
): CheckPerProfileBudgetResult {
  const { profile, estimatedInputTokens, usage, budget } = input;
  const pm = effectivePaymentModel(profile);

  // 1. Input-token caps (all paymentModels, when set).
  if (budget.dailyInputTokenLimit !== undefined &&
      usage.today.inputTokens + estimatedInputTokens > budget.dailyInputTokenLimit) {
    return { blocked: true, reason: `daily input token cap reached (${budget.dailyInputTokenLimit.toLocaleString()})` };
  }
  if (budget.monthlyInputTokenLimit !== undefined &&
      usage.month.inputTokens + estimatedInputTokens > budget.monthlyInputTokenLimit) {
    return { blocked: true, reason: `monthly input token cap reached (${budget.monthlyInputTokenLimit.toLocaleString()})` };
  }

  // 2. USD caps — per-token only. Requires per-token cost data on the profile.
  if (pm === "per-token" && profile.cost && profile.cost.type === "per-token") {
    const estUsd = (estimatedInputTokens / 1_000_000) * profile.cost.inputUsdPerMillion;
    if (budget.dailyUsdLimit !== undefined &&
        usage.today.costUsd + estUsd > budget.dailyUsdLimit) {
      return { blocked: true, reason: `daily USD cap reached ($${budget.dailyUsdLimit.toFixed(2)})` };
    }
    if (budget.monthlyUsdLimit !== undefined &&
        usage.month.costUsd + estUsd > budget.monthlyUsdLimit) {
      return { blocked: true, reason: `monthly USD cap reached ($${budget.monthlyUsdLimit.toFixed(2)})` };
    }
  }

  return "ok";
}
