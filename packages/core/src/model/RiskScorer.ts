import type { ModelTier } from "./ModelProfile.js";
import type { TaskType } from "./TaskClassifier.js";

export interface RiskInput {
  task: string;
  filesTouchedEstimate?: number;
  involvesSecrets?: boolean;
  involvesProductionInfra?: boolean;
  /** Optional classifier output. When set, contributes to the risk score so
   *  code-review / plan / refactor tasks escalate even without HIGH/MEDIUM keyword matches. */
  taskType?: TaskType;
}

export interface RiskScore {
  score: number;
  reasons: string[];
}

const HIGH_RISK_KEYWORDS = [
  "production",
  "prod",
  "secret",
  "credential",
  "auth",
  "migration",
  "delete",
  "drop",
  "rm -rf",
  "billing",
];

const MEDIUM_RISK_KEYWORDS = [
  "refactor",
  "rewrite",
  "architecture",
  "schema",
  "infrastructure",
  "deploy",
];

export function scoreRisk(input: RiskInput): RiskScore {
  const reasons: string[] = [];
  let score = 10;

  const text = input.task.toLowerCase();
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      score += 30;
      reasons.push(`task mentions high-risk keyword "${kw}"`);
      break;
    }
  }
  for (const kw of MEDIUM_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      score += 15;
      reasons.push(`task mentions medium-risk keyword "${kw}"`);
      break;
    }
  }

  if (input.taskType) {
    const taskTypeWeight: Partial<Record<TaskType, number>> = {
      "code-review": 20,
      "plan": 15,
      "refactor": 15,
      // code-generation/summarize/translate/general → 0
    };
    const bump = taskTypeWeight[input.taskType] ?? 0;
    if (bump > 0) {
      score += bump;
      reasons.push(`task classified as "${input.taskType}" (+${bump})`);
    }
  }

  if (input.filesTouchedEstimate !== undefined) {
    if (input.filesTouchedEstimate >= 10) {
      score += 20;
      reasons.push(`large change set (~${input.filesTouchedEstimate} files)`);
    } else if (input.filesTouchedEstimate >= 3) {
      score += 10;
      reasons.push(`multi-file change (~${input.filesTouchedEstimate} files)`);
    }
  }

  if (input.involvesSecrets) {
    score += 25;
    reasons.push("task involves secrets");
  }
  if (input.involvesProductionInfra) {
    score += 25;
    reasons.push("task involves production infrastructure");
  }

  return { score: Math.min(100, score), reasons };
}

export interface RiskThresholds {
  localFastMax: number;
  localStrongMax: number;
  privateRemoteMax: number;
  publicCloudReviewMin: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  localFastMax: 25,
  localStrongMax: 50,
  privateRemoteMax: 75,
  publicCloudReviewMin: 76,
};

export function tierForScore(score: number, t: RiskThresholds = DEFAULT_RISK_THRESHOLDS): ModelTier {
  if (score <= t.localStrongMax) return "local-device";
  if (score <= t.privateRemoteMax) return "private-remote";
  return "public-cloud";
}
