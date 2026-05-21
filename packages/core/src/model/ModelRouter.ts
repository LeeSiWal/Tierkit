import type { ModelTier, ModelProfile, ModelProfileMap, ModelPolicy } from "./ModelProfile.js";
import { effectivePaymentModel, type PaymentModel } from "./ModelProfile.js";
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

const PAYMENT_RANK: Record<PaymentModel, number> = {
  "free": 0,
  "flat-rate": 1,
  "per-token": 2,
};
function paymentRank(p: ModelProfile): number {
  return PAYMENT_RANK[effectivePaymentModel(p)] ?? 99;
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
  const goodAtRank = (p: ModelProfile): number => {
    if (!p.goodAt || p.goodAt.length === 0) return 1; // neutral
    if (p.goodAt.includes(taskType)) return 0;          // fit
    return 2;                                            // anti-fit
  };
  return inTier
    .map(([id, p], idx) => ({ id, p, idx }))
    .sort((a, b) =>
      (paymentRank(a.p) - paymentRank(b.p)) ||
      (goodAtRank(a.p) - goodAtRank(b.p)) ||
      (a.idx - b.idx),
    )
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
  const seen = new Set<string>();
  for (const tier of TIER_ORDER) {
    if (tierRank(tier) < tierRank(primaryTier)) continue;
    if (tierRank(tier) > ceilingRank) break;
    const sorted = sortProfilesForTier(profiles, tier, taskType);
    for (const id of sorted) {
      chain.push({ id, tier, isEscalation: tier !== primaryTier });
      seen.add(id);
    }
  }
  // Tail fallback: append tiers BELOW the primary tier (low→high) as a last-resort
  // chain. The user's intent: "API 키가 없어도 로컬로 떨어져야 한다" — when a
  // private-remote/public-cloud primary candidate fails viability (e.g. no API
  // key set on this machine), the walker should still find a viable local /
  // private profile instead of dead-ending. Order: higher fallback tiers first
  // (closer to primary), so we step down rather than dropping straight to local.
  const primaryRank = tierRank(primaryTier);
  for (let r = primaryRank - 1; r >= 0; r--) {
    const tier = TIER_ORDER[r]!;
    const sorted = sortProfilesForTier(profiles, tier, taskType);
    for (const id of sorted) {
      if (seen.has(id)) continue;
      chain.push({ id, tier, isEscalation: true });
      seen.add(id);
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
