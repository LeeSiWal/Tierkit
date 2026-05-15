import { loadConfig } from "../config/loadConfig.js";
import type { ModelProfile, ModelTier } from "../model/ModelProfile.js";
import { decideRoute, type RouteDecision } from "../model/ModelRouter.js";
import type { RiskInput, RiskThresholds } from "../model/RiskScorer.js";

export interface ExplainRouteUsecaseInput {
  task: string;
  cwd?: string;
  /** Optional overrides forwarded to RiskScorer. */
  filesTouchedEstimate?: number;
  involvesSecrets?: boolean;
  involvesProductionInfra?: boolean;
}

export interface ExplainRouteUsecaseResult {
  task: string;
  decision: RouteDecision;
  profile?: ModelProfile;
  thresholds: RiskThresholds;
  /** All profiles that match the chosen tier, in declaration order. The router picks the first. */
  candidates: { id: string; profile: ModelProfile }[];
}

export async function explainRoute(
  input: ExplainRouteUsecaseInput,
): Promise<ExplainRouteUsecaseResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);

  const riskInput: RiskInput = {
    task: input.task,
    ...(input.filesTouchedEstimate !== undefined
      ? { filesTouchedEstimate: input.filesTouchedEstimate }
      : {}),
    ...(input.involvesSecrets !== undefined ? { involvesSecrets: input.involvesSecrets } : {}),
    ...(input.involvesProductionInfra !== undefined
      ? { involvesProductionInfra: input.involvesProductionInfra }
      : {}),
  };

  const thresholds = cfg.config.routingPolicy.riskThresholds;

  const decision = decideRoute({
    task: riskInput,
    profiles: cfg.config.modelProfiles,
    thresholds,
    ...(cfg.config.modelPolicy ? { policy: cfg.config.modelPolicy } : {}),
  });

  const candidates = Object.entries(cfg.config.modelProfiles)
    .filter(([, p]) => p.kind === (decision.tier as ModelTier))
    .map(([id, profile]) => ({ id, profile }));

  const profile = decision.profileId
    ? cfg.config.modelProfiles[decision.profileId]
    : undefined;

  return {
    task: input.task,
    decision,
    ...(profile ? { profile } : {}),
    thresholds,
    candidates,
  };
}
