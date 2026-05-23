/**
 * v0.21.7: compute today's Tierkit savings from MCP activity.
 *
 * Why this exists separately from the routing-savings card:
 *   - The old `/v1/savings/today` measures "cloud calls avoided by routing
 *     LLM traffic to a local model". That's the v0.17 metric and it's
 *     meaningful only when Tierkit acts as the LLM router.
 *   - In v0.21, the dominant flow is Tierkit Chat → claude CLI subprocess.
 *     claude does its own LLM calls; the routing engine never sees them.
 *     So the routing card sits at 0 forever and the user doesn't feel any
 *     value from Tierkit.
 *
 * The actually-meaningful number in v0.21 is **how many input tokens did
 * Tierkit MCP compress before Claude saw them**. Every tierkit.compress_*
 * and tierkit.get_*_digest call records its own beforeTokens / afterTokens
 * stats in the MCP activity log via summarizeOutput in mcp-server. Sum
 * those `savedTokens` across today's calls and multiply by the baseline
 * provider's input cost-per-token to get a real USD savings number.
 *
 * Display this in the existing "Today" card so users see the gateway
 * delivering value with every chat turn.
 */
import { readMcpActivity, type McpActivityEntry } from "../mcp/activityLog.js";

export interface TierkitMcpSavingsSummary {
  /** Number of tierkit.* tool calls counted in the window. */
  toolCallCount: number;
  /** Sum of input tokens BEFORE compression across all counted calls. */
  beforeTokensTotal: number;
  /** Sum of input tokens AFTER compression. */
  afterTokensTotal: number;
  /** beforeTokensTotal - afterTokensTotal (always ≥ 0). */
  savedTokensTotal: number;
  /** USD savings, computed as savedTokensTotal × baselineInputUsdPerMillion / 1e6.
   *  Set to undefined when baselineInputUsdPerMillion is not provided. */
  estimatedSavedUsd?: number;
  /** Breakdown by tool name → call count. Useful so the user sees which
   *  digest tools Claude actually used. */
  byTool: Record<string, number>;
  /** ISO start of the counting window (today, UTC midnight). */
  windowStart: string;
}

const TIERKIT_TOOL_PREFIX = "tierkit.";
const COMPRESSION_TOOL_PREFIXES = [
  "tierkit.compress_",
  "tierkit.get_error_digest",
  "tierkit.get_test_digest",
  "tierkit.get_json_digest",
  "tierkit.get_file_digest",
  "tierkit.get_diff_summary",
  "tierkit.build_context_pack",
];

function isCompressionTool(name: string): boolean {
  return COMPRESSION_TOOL_PREFIXES.some((p) => name === p || name.startsWith(p));
}

/**
 * Sum today's Tierkit MCP compression savings.
 *
 * @param workspaceRoot project root (used to locate usage.jsonl)
 * @param baselineInputUsdPerMillion optional — when provided, populates
 *   estimatedSavedUsd. Use the baseline profile's cost.inputUsdPerMillion
 *   (or the auto-fallback profile's). Without this, USD is left undefined
 *   so the UI can render "—" instead of a misleading $0.
 */
export async function computeTierkitMcpSavings(
  workspaceRoot: string,
  baselineInputUsdPerMillion?: number,
): Promise<TierkitMcpSavingsSummary> {
  const windowStart = new Date();
  windowStart.setUTCHours(0, 0, 0, 0);
  const startMs = windowStart.getTime();

  const entries = await readMcpActivity(workspaceRoot);
  let toolCallCount = 0;
  let beforeTokensTotal = 0;
  let afterTokensTotal = 0;
  const byTool: Record<string, number> = {};

  for (const e of entries) {
    if (!e || typeof e.ts !== "string") continue;
    if (!e.tool || !e.tool.startsWith(TIERKIT_TOOL_PREFIX)) continue;
    if (!e.ok) continue; // count only successful compressions
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || ts < startMs) continue;
    if (!isCompressionTool(e.tool)) continue;

    const summary = (e.outputSummary ?? null) as {
      beforeTokens?: unknown;
      afterTokens?: unknown;
      savedTokens?: unknown;
    } | null;
    const before = Number(summary?.beforeTokens);
    const after = Number(summary?.afterTokens);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;

    beforeTokensTotal += before;
    afterTokensTotal += after;
    toolCallCount += 1;
    byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
  }

  const savedTokensTotal = Math.max(0, beforeTokensTotal - afterTokensTotal);
  const estimatedSavedUsd =
    typeof baselineInputUsdPerMillion === "number" && baselineInputUsdPerMillion > 0
      ? (savedTokensTotal * baselineInputUsdPerMillion) / 1_000_000
      : undefined;

  return {
    toolCallCount,
    beforeTokensTotal,
    afterTokensTotal,
    savedTokensTotal,
    ...(estimatedSavedUsd !== undefined ? { estimatedSavedUsd } : {}),
    byTool,
    windowStart: windowStart.toISOString(),
  };
}

// Re-export for downstream consumers if they need it (kept for symmetry with
// other runtime usage helpers).
export type { McpActivityEntry };
