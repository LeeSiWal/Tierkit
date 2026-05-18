import { loadConfig } from "../config/loadConfig.js";
import type { ModelProfile, ModelTier } from "../model/ModelProfile.js";
import { decideRoute, type RouteDecision } from "../model/ModelRouter.js";
import type { RiskInput, RiskThresholds } from "../model/RiskScorer.js";
import { classifyTask, type TaskType } from "../model/TaskClassifier.js";

export interface ExplainRouteUsecaseInput {
  task: string;
  cwd?: string;
  filesTouchedEstimate?: number;
  involvesSecrets?: boolean;
  involvesProductionInfra?: boolean;
}

export interface ExplainRouteUsecaseResult {
  task: string;
  taskType: TaskType;
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
    ...(input.filesTouchedEstimate !== undefined ? { filesTouchedEstimate: input.filesTouchedEstimate } : {}),
    ...(input.involvesSecrets !== undefined ? { involvesSecrets: input.involvesSecrets } : {}),
    ...(input.involvesProductionInfra !== undefined ? { involvesProductionInfra: input.involvesProductionInfra } : {}),
  };

  const thresholds = cfg.config.routingPolicy.riskThresholds;
  const taskType = classifyTask(input.task);

  const decision = decideRoute({
    task: riskInput,
    profiles: cfg.config.modelProfiles,
    thresholds,
    ceiling: cfg.config.routingPolicy.autoEscalationCeiling,
    taskType,
    ...(cfg.config.modelPolicy ? { policy: cfg.config.modelPolicy } : {}),
  });

  const candidates = Object.entries(cfg.config.modelProfiles)
    .filter(([, p]) => p.kind === (decision.tier as ModelTier))
    .map(([id, profile]) => ({ id, profile }));

  const profile = decision.profileId ? cfg.config.modelProfiles[decision.profileId] : undefined;

  return {
    task: input.task,
    taskType,
    decision,
    ...(profile ? { profile } : {}),
    thresholds,
    candidates,
  };
}
