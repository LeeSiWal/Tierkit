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
import { attributeModelFromJsonls } from "./attributeModelFromJsonls.js";
import type { TierkitConfig } from "../config/TierkitConfig.js";
import type { ModelCost, ModelProfile } from "../model/ModelProfile.js";

export interface ClientOrModelSummary {
  toolCallCount: number;
  savedTokens: number;
  estimatedSavedUsd?: number;
}

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
  /** v0.23: per-client breakdown (Claude Code, Codex, …). Older log entries
   *  without clientName bucket to "unknown". */
  byClient: Record<string, ClientOrModelSummary>;
  /** v0.23: per-Claude-model breakdown via jsonl cross-reference. Non-claude
   *  clients are excluded — they appear only in byClient. */
  byModel: Record<string, ClientOrModelSummary>;
}

export interface ComputeOptions {
  homeDirOverride?: string;
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
  options: ComputeOptions = {},
): Promise<TierkitMcpSavingsSummary> {
  const windowStart = new Date();
  windowStart.setUTCHours(0, 0, 0, 0);
  const startMs = windowStart.getTime();

  const entries = await readMcpActivity(workspaceRoot);
  let toolCallCount = 0;
  let beforeTokensTotal = 0;
  let afterTokensTotal = 0;
  const byTool: Record<string, number> = {};
  const forAttribution: Array<{ ts: string; clientName: string; savedTokens: number }> = [];

  for (const e of entries) {
    if (!e || typeof e.ts !== "string") continue;
    if (!e.tool || !e.tool.startsWith(TIERKIT_TOOL_PREFIX)) continue;
    if (!e.ok) continue;
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
    forAttribution.push({
      ts: e.ts,
      clientName: (e as { clientName?: string }).clientName ?? "unknown",
      savedTokens: Math.max(0, before - after),
    });
  }

  const savedTokensTotal = Math.max(0, beforeTokensTotal - afterTokensTotal);
  const estimatedSavedUsd =
    typeof baselineInputUsdPerMillion === "number" && baselineInputUsdPerMillion > 0
      ? (savedTokensTotal * baselineInputUsdPerMillion) / 1_000_000
      : undefined;

  const attributed = await attributeModelFromJsonls({
    cwd: workspaceRoot,
    ...(options.homeDirOverride ? { homeDirOverride: options.homeDirOverride } : {}),
    activities: forAttribution,
  });

  const byClient: Record<string, ClientOrModelSummary> = {};
  const byModel: Record<string, ClientOrModelSummary> = {};
  const usdFor = (tokens: number): number | undefined =>
    typeof baselineInputUsdPerMillion === "number" && baselineInputUsdPerMillion > 0
      ? (tokens * baselineInputUsdPerMillion) / 1_000_000
      : undefined;

  for (const a of attributed) {
    const cb = (byClient[a.clientName] ??= { toolCallCount: 0, savedTokens: 0 });
    cb.toolCallCount += 1;
    cb.savedTokens += a.savedTokens;
    if (a.clientName.startsWith("claude")) {
      const mb = (byModel[a.model] ??= { toolCallCount: 0, savedTokens: 0 });
      mb.toolCallCount += 1;
      mb.savedTokens += a.savedTokens;
    }
  }
  for (const v of Object.values(byClient)) {
    const usd = usdFor(v.savedTokens);
    if (usd !== undefined) v.estimatedSavedUsd = usd;
  }
  for (const v of Object.values(byModel)) {
    const usd = usdFor(v.savedTokens);
    if (usd !== undefined) v.estimatedSavedUsd = usd;
  }

  return {
    toolCallCount,
    beforeTokensTotal,
    afterTokensTotal,
    savedTokensTotal,
    ...(estimatedSavedUsd !== undefined ? { estimatedSavedUsd } : {}),
    byTool,
    windowStart: windowStart.toISOString(),
    byClient,
    byModel,
  };
}

// Re-export for downstream consumers if they need it (kept for symmetry with
// other runtime usage helpers).
export type { McpActivityEntry };

export interface ResolvedSavingsBaseline {
  baselineId: string;
  baseProfile: ModelProfile | undefined;
  inputUsdPerMillion: number | undefined;
}

/**
 * Pick the model profile whose input $/M will be used to convert savedTokens
 * into a dollar number for the Savings card. Same heuristic as the
 * /v1/tierkit/savings/today route (v0.21.6): if the routing baseline is
 * flat-rate or free, fall back to a priced profile of the same provider family
 * (claude → claude-*, openai → openai-*) before falling back across families.
 */
function isPerTokenCost(c: ModelCost | undefined): c is Extract<ModelCost, { type: "per-token" }> {
  return c?.type === "per-token";
}

export function resolveSavingsBaseline(config: TierkitConfig): ResolvedSavingsBaseline {
  const profiles = config.modelProfiles ?? {};
  const requestedId = config.routingBaseline ?? "claudeCode";
  const claudeProviders = new Set(["anthropic", "claude-code"]);
  const openaiProviders = new Set(["openai", "openai-compatible"]);
  const requestedProv = profiles[requestedId]?.provider ?? "claude-code";
  const requestedFam = claudeProviders.has(requestedProv) ? "claude"
    : openaiProviders.has(requestedProv) ? "openai" : "other";
  const famOf = (p: ModelProfile | undefined): string => {
    const prov = p?.provider ?? "";
    if (claudeProviders.has(prov)) return "claude";
    if (openaiProviders.has(prov)) return "openai";
    return "other";
  };
  let baselineId = requestedId;
  let baseProfile = profiles[baselineId];
  if (!isPerTokenCost(baseProfile?.cost)) {
    const priced = Object.entries(profiles)
      .filter((entry): entry is [string, ModelProfile & { cost: Extract<ModelCost, { type: "per-token" }> }] =>
        isPerTokenCost(entry[1]?.cost));
    priced.sort(([, a], [, b]) => {
      const af = famOf(a) === requestedFam ? 0 : 1;
      const bf = famOf(b) === requestedFam ? 0 : 1;
      if (af !== bf) return af - bf;
      const ac = a.cost.inputUsdPerMillion ?? 0;
      const bc = b.cost.inputUsdPerMillion ?? 0;
      return bc - ac;
    });
    const cand = priced[0];
    if (cand) { baselineId = cand[0]; baseProfile = cand[1]; }
  }
  const inputUsdPerMillion = isPerTokenCost(baseProfile?.cost)
    ? baseProfile.cost.inputUsdPerMillion
    : undefined;
  return { baselineId, baseProfile, inputUsdPerMillion };
}
