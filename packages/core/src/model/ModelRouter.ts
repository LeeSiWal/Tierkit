import type { ModelTier, ModelProfile, ModelProfileMap, ModelPolicy } from "./ModelProfile.js";
import {
  DEFAULT_RISK_THRESHOLDS,
  scoreRisk,
  tierForScore,
  type RiskInput,
  type RiskThresholds,
} from "./RiskScorer.js";

export interface RouteCandidate {
  id: string;
  tier: ModelTier;
  /** False for primary-tier candidates, true for candidates added by escalation. */
  isEscalation: boolean;
}

export interface RouteDecision {
  tier: ModelTier;
  profileId: string | null;
  score: number;
  reasons: string[];
  requiresApproval: boolean;
  mode: "execute" | "review-only";
  /** Ordered list — walker tries in sequence on transient failures. */
  escalationChain: RouteCandidate[];
}

export interface ExplainRouteInput {
  task: RiskInput;
  profiles: ModelProfileMap;
  policy?: ModelPolicy;
  thresholds?: RiskThresholds;
  /** Cap for escalation tiers. Defaults to "public-cloud". */
  ceiling?: ModelTier;
  /** Used to sort profiles within each tier (goodAt-aware). Defaults to "general". */
  taskType?: string;
}

const TIER_ORDER: ModelTier[] = ["local-device", "private-remote", "public-cloud"];

function tierRank(t: ModelTier): number {
  return TIER_ORDER.indexOf(t);
}

/**
 * goodAt-aware sort + notGoodAt hard filter. Profiles whose `notGoodAt` includes the
 * current taskType are EXCLUDED from the chain entirely (not just demoted). The remaining
 * profiles sort by goodAt match: fit first, then neutral (no goodAt), then anti-fit (has
 * goodAt but taskType not in it). Declaration order breaks ties.
 *
 * Why hard-filter instead of just demoting: weak local models (e.g., llama3.2:3b) flagged
 * with `notGoodAt: ["code-review"]` should NEVER be tried for a code-review task — better
 * to escalate to private-remote than to ship a bad 3B-model review. The fallback walker
 * would otherwise eventually reach them when stronger candidates fail.
 */
function sortProfilesForTier(
  profiles: ModelProfileMap,
  tier: ModelTier,
  taskType: string,
): string[] {
  const inTier = Object.entries(profiles).filter(([, p]) =>
    p.kind === tier &&
    p.enabled !== false &&
    !(p.notGoodAt && p.notGoodAt.includes(taskType)),
  );
  const rank = (p: ModelProfile): number => {
    if (!p.goodAt || p.goodAt.length === 0) return 1; // neutral
    if (p.goodAt.includes(taskType)) return 0;          // fit
    return 2;                                            // anti-fit
  };
  return inTier
    .map(([id, p], idx) => ({ id, p, idx }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.idx - b.idx)
    .map((x) => x.id);
}

export function buildEscalationChain(
  profiles: ModelProfileMap,
  primaryTier: ModelTier,
  ceiling: ModelTier,
  taskType: string,
): RouteCandidate[] {
  const chain: RouteCandidate[] = [];
  const ceilingRank = tierRank(ceiling);
  for (const tier of TIER_ORDER) {
    if (tierRank(tier) < tierRank(primaryTier)) continue;
    if (tierRank(tier) > ceilingRank) break;
    const sorted = sortProfilesForTier(profiles, tier, taskType);
    for (const id of sorted) {
      chain.push({ id, tier, isEscalation: tier !== primaryTier });
    }
  }
  return chain;
}

export function decideRoute(input: ExplainRouteInput): RouteDecision {
  const { task, profiles, policy, thresholds = DEFAULT_RISK_THRESHOLDS } = input;
  const ceiling = input.ceiling ?? "public-cloud";
  const taskType = input.taskType ?? "general";

  const { score, reasons } = scoreRisk(task);
  const tier = tierForScore(score, thresholds);

  const escalationChain = buildEscalationChain(profiles, tier, ceiling, taskType);
  const profileId = escalationChain.find((c) => c.tier === tier)?.id ?? null;
  const profile = profileId ? profiles[profileId] : undefined;

  let requiresApproval = false;
  let mode: "execute" | "review-only" = "execute";

  if (tier === "public-cloud") {
    requiresApproval = policy?.publicCloudRequiresApproval ?? true;
    mode = policy?.publicCloudDefaultMode ?? "review-only";
  } else if (profile?.requiresApproval) {
    requiresApproval = true;
  }

  return { tier, profileId, score, reasons, requiresApproval, mode, escalationChain };
}
