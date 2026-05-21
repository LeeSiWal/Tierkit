import type { UsageRecord } from "./usageLog.js";
import { estimateCost } from "./usageLog.js";
import type { ModelProfile } from "../model/ModelProfile.js";

export interface RoutingSavingsSummary {
  /** Profile model id of the baseline used for cost estimation. */
  baselineProfileId: string;
  baselineDisplayName: string;
  /** Sum of inputTokens from eligible local-device calls in the window. */
  inputTokensRouted: number;
  /** Sum of outputTokens from eligible local-device calls in the window. */
  outputTokensRouted: number;
  /** USD that WOULD have been spent if the routed traffic had gone to the baseline. */
  estimatedCostSaved: number;
  /** Count of local-device successful LLM calls in the window. */
  cloudCallsAvoided: number;
  /** ISO timestamp of the window start (i.e. the `since` arg). */
  windowStart: string;
}

/**
 * Compute routing savings for the window [since, now]. Filters:
 *   1. Records with `type === "mcp-tool"` are NOT LLM calls — skipped.
 *   2. `tier === "local-device"` — only locally-served calls count as savings.
 *   3. `ok === true` — failed calls saved nothing.
 *   4. `timestamp >= since`.
 *   5. Records with missing or NaN inputTokens / outputTokens are skipped.
 *
 * The estimated cost is computed once over the summed tokens (linear in
 * `estimateCost`), not per-record.
 */
export function computeRoutingSavings(
  records: UsageRecord[],
  baseline: ModelProfile,
  since: Date,
): RoutingSavingsSummary {
  const sinceMs = since.getTime();
  let inputTokens = 0;
  let outputTokens = 0;
  let count = 0;
  for (const r of records as Array<UsageRecord & { type?: string }>) {
    // usage.jsonl is heterogeneous: LLM-call records (type: "chat"|"model-test"|undefined)
    // and MCP-tool records (type: "mcp-tool") share the file. Filter MCP-tool out
    // before treating the row as an LLM call.
    if ((r.type as string | undefined) === "mcp-tool") continue;
    if (r.tier !== "local-device") continue;
    if (r.ok !== true) continue;
    const ts = Date.parse(r.timestamp);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    if (!Number.isFinite(r.inputTokens) || !Number.isFinite(r.outputTokens)) continue;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    count += 1;
  }
  return {
    baselineProfileId: baseline.model,
    baselineDisplayName: baseline.displayName ?? baseline.model,
    inputTokensRouted: inputTokens,
    outputTokensRouted: outputTokens,
    estimatedCostSaved: estimateCost(baseline, inputTokens, outputTokens),
    cloudCallsAvoided: count,
    windowStart: since.toISOString(),
  };
}
