import { loadConfig } from "../../config/loadConfig.js";
import { decideRoute, buildEscalationChain } from "../../model/ModelRouter.js";
import type { ModelTier } from "../../model/ModelProfile.js";
import { classifyTask, type TaskType } from "../../model/TaskClassifier.js";
import { partitionByViability } from "../../model/profileViability.js";
import { checkBudget } from "../budget.js";
import path from "node:path";

export interface AutoResolveInput {
  cwd: string;
  env: Record<string, string | undefined>;
  lastUserMessage: string;
}

export interface AutoResolveResult {
  candidateIds: string[];
  taskType: TaskType;
  /** Set when budget-aware downgrade lowered the starting tier. */
  downgradedFromTier?: ModelTier;
  /** Set when budget exceeded — public-cloud candidates were pruned. */
  budgetPrunedPublicCloud: boolean;
}

const TIER_ORDER: ModelTier[] = ["local-device", "private-remote", "public-cloud"];

const TIER_DOWN: Record<ModelTier, ModelTier | null> = {
  "public-cloud": "private-remote",
  "private-remote": "local-device",
  "local-device": null,
};

export async function resolveAutoCandidates(
  input: AutoResolveInput,
): Promise<AutoResolveResult> {
  const cfg = await loadConfig(input.cwd);
  const taskType = classifyTask(input.lastUserMessage);
  const policy = cfg.config.routingPolicy;

  // 1. Decide primary route.
  const decision = decideRoute({
    task: { task: input.lastUserMessage },
    profiles: cfg.config.modelProfiles,
    thresholds: policy.riskThresholds,
    ceiling: policy.autoEscalationCeiling,
    taskType,
    ...(cfg.config.modelPolicy ? { policy: cfg.config.modelPolicy } : {}),
  });

  // 2. Budget-aware downgrade.
  let downgradedFromTier: ModelTier | undefined;
  let budgetPrunedPublicCloud = false;
  let chain = decision.escalationChain;

  if (policy.budgetAwareDowngrade && cfg.config.budget) {
    const usagePath = path.join(input.cwd, cfg.config.runtime.dataDir, "usage.jsonl");
    const budget = await checkBudget(usagePath, cfg.config.budget);
    const dailyPct =
      budget.dailyLimitUsd && budget.dailyLimitUsd > 0
        ? (budget.dailyUsedUsd / budget.dailyLimitUsd) * 100
        : 0;

    if (dailyPct >= 80) {
      const down = TIER_DOWN[decision.tier];
      if (down) {
        const lowerChain = buildEscalationChain(
          cfg.config.modelProfiles,
          down,
          policy.autoEscalationCeiling,
          taskType,
        );
        if (lowerChain.length > 0) {
          chain = lowerChain;
          downgradedFromTier = decision.tier;
        }
      }
    }

    if (dailyPct >= 100) {
      chain = chain.filter((c) => c.tier !== "public-cloud");
      budgetPrunedPublicCloud = true;
    }
  }

  // 3. Viability prune.
  const { viable, nonViable } = await partitionByViability(
    chain.map((c) => ({ id: c.id })),
    (id) => cfg.config.modelProfiles[id],
    input.env,
  );
  const candidateIds =
    viable.length > 0 ? viable.map((v) => v.id) : nonViable.map((v) => v.id);

  return {
    candidateIds,
    taskType,
    ...(downgradedFromTier ? { downgradedFromTier } : {}),
    budgetPrunedPublicCloud,
  };
}
