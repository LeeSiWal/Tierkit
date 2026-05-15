import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProfile, ModelTier } from "../model/ModelProfile.js";

export interface UsageRecord {
  timestamp: string;
  profileId: string;
  provider: string;
  model: string;
  tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  /** Stable failure code when ok=false; one of `unreachable`, `unauthorized`, `bad-status`, ... */
  failureCode?: string;
}

/** Append a usage record as a single JSON line. Creates the directory if needed. */
export async function appendUsage(filePath: string, record: UsageRecord): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
}

/** Read all records. Returns [] when the file does not yet exist. */
export async function readUsage(filePath: string): Promise<UsageRecord[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    const out: UsageRecord[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as UsageRecord);
      } catch {
        // skip malformed lines — usage log is append-only telemetry, not source of truth
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface UsageSummary {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byProfile: Map<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>;
}

export function summarizeUsage(records: UsageRecord[], since?: Date): UsageSummary {
  const cutoff = since?.getTime();
  const summary: UsageSummary = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    byProfile: new Map(),
  };
  for (const r of records) {
    if (cutoff !== undefined && new Date(r.timestamp).getTime() < cutoff) continue;
    summary.totalCalls += 1;
    if (r.ok) summary.successfulCalls += 1;
    else summary.failedCalls += 1;
    summary.totalInputTokens += r.inputTokens;
    summary.totalOutputTokens += r.outputTokens;
    summary.totalCostUsd += r.costUsd;
    const cur = summary.byProfile.get(r.profileId) ?? {
      calls: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    cur.calls += 1;
    cur.costUsd += r.costUsd;
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    summary.byProfile.set(r.profileId, cur);
  }
  return summary;
}

export function estimateCost(
  profile: ModelProfile,
  inputTokens: number,
  outputTokens: number,
): number {
  const c = profile.cost;
  if (!c) return 0;
  if (c.type === "free") return 0;
  if (c.type === "flat") return 0; // monthly — per-call cost is amortized elsewhere
  return (
    (inputTokens / 1_000_000) * c.inputUsdPerMillion +
    (outputTokens / 1_000_000) * c.outputUsdPerMillion
  );
}
