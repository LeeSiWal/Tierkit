import type { ModelTier, ModelProfileMap, ModelPolicy } from "./ModelProfile.js";
import {
  DEFAULT_RISK_THRESHOLDS,
  scoreRisk,
  tierForScore,
  type RiskInput,
  type RiskThresholds,
} from "./RiskScorer.js";

export interface RouteDecision {
  tier: ModelTier;
  profileId: string | null;
  score: number;
  reasons: string[];
  requiresApproval: boolean;
  mode: "execute" | "review-only";
}

export interface ExplainRouteInput {
  task: RiskInput;
  profiles: ModelProfileMap;
  policy?: ModelPolicy;
  thresholds?: RiskThresholds;
}

export function decideRoute(input: ExplainRouteInput): RouteDecision {
  const { task, profiles, policy, thresholds = DEFAULT_RISK_THRESHOLDS } = input;
  const { score, reasons } = scoreRisk(task);
  const tier = tierForScore(score, thresholds);

  const profileId = pickProfileIdForTier(profiles, tier);
  const profile = profileId ? profiles[profileId] : undefined;

  let requiresApproval = false;
  let mode: "execute" | "review-only" = "execute";

  if (tier === "public-cloud") {
    requiresApproval = policy?.publicCloudRequiresApproval ?? true;
    mode = policy?.publicCloudDefaultMode ?? "review-only";
  } else if (profile?.requiresApproval) {
    requiresApproval = true;
  }

  return { tier, profileId: profileId ?? null, score, reasons, requiresApproval, mode };
}

function pickProfileIdForTier(profiles: ModelProfileMap, tier: ModelTier): string | undefined {
  for (const [id, profile] of Object.entries(profiles)) {
    if (profile.kind === tier) return id;
  }
  return undefined;
}
