import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { readUsage, summarizeUsage, type UsageRecord, type UsageSummary } from "../runtime/usageLog.js";

export interface UsageInput {
  cwd?: string;
  /** Only summarize records on or after this date. */
  since?: Date;
}

export interface UsageResult {
  projectRoot: string;
  usageLogPath: string;
  records: UsageRecord[];
  summary: UsageSummary;
}

export async function usage(input: UsageInput = {}): Promise<UsageResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  const usageLogPath = path.join(projectRoot, cfg.config.runtime.dataDir, "usage.jsonl");
  const records = await readUsage(usageLogPath);
  const summary = summarizeUsage(records, input.since);
  return { projectRoot, usageLogPath, records, summary };
}
