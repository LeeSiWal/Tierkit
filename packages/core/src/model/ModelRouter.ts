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
 * goodAt-aware sort: profiles matching taskType first, then neutral (no goodAt), then anti-fit.
 * Declaration order breaks ties (Object.entries preserves insertion order on modern V8).
 */
function sortProfilesForTier(
  profiles: ModelProfileMap,
  tier: ModelTier,
  taskType: string,
): string[] {
  const inTier = Object.entries(profiles).filter(([, p]) => p.kind === tier);
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
