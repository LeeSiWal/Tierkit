import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProfile, ModelTier } from "../model/ModelProfile.js";

const TRIM_TRIGGER_BYTES = 10 * 1024 * 1024;  // trim once file exceeds 10 MB
const TRIM_TARGET_BYTES = 5 * 1024 * 1024;    // keep most-recent ~5 MB after trim

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
  /** Where the token usage counts came from. Absent on records before v0.13. */
  usageSource?: "provider-reported" | "estimated";
  /** Operation type. `undefined` (back-compat) and `"chat"` both mean a normal chat call. */
  type?: "chat" | "model-test";
}

/**
 * v0.17: in-place trim of a usage log file. Keep only the most recent
 * `targetBytes` worth of complete JSON lines, discard older ones. Atomic via
 * tmp + rename. Called from appendUsage when file size exceeds
 * TRIM_TRIGGER_BYTES (10 MB), bringing it back under TRIM_TARGET_BYTES (5 MB),
 * so the next ~5 MB of appends accumulate before the next trim.
 *
 * The log file is heterogeneous-shape safe: LLM-call records and MCP-tool
 * records (`type: "mcp-tool"`) coexist; the trim doesn't distinguish — it
 * keeps complete lines from the end regardless of shape.
 */
async function trimUsageLog(filePath: string, targetBytes: number): Promise<void> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const kept: string[] = [];
  let keptBytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineSize = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (keptBytes + lineSize > targetBytes && kept.length > 0) break;
    kept.unshift(lines[i]!);
    keptBytes += lineSize;
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  await fs.rename(tmp, filePath);
}

/** Append a usage record as a single JSON line. Creates the directory if needed. */
export async function appendUsage(filePath: string, record: UsageRecord): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // v0.17: cheap stat() before append; if over 10 MB, trim down to ~5 MB.
  // Trim is rare (every ~5 MB of appends) so the stat is effectively free.
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > TRIM_TRIGGER_BYTES) {
      await trimUsageLog(filePath, TRIM_TARGET_BYTES);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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
        const o = JSON.parse(line) as Partial<UsageRecord> & { type?: string };
        // usage.jsonl co-stores mcp-tool entries (uses `ts`, lacks profileId).
        // readUsage's typed contract is UsageRecord[], so drop foreign shapes —
        // otherwise summarizeUsage / aggregateByProfile crash on r.timestamp.
        if (typeof o.timestamp !== "string" || typeof o.profileId !== "string") continue;
        out.push(o as UsageRecord);
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

/** Per-profile usage breakdown shape used by /v1/usage.profiles and budget gate. */
export interface ProfileUsageEntry {
  today: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  month: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
}

/**
 * Group successful usage records by profileId, splitting into today and
 * this-month bins relative to `now`. Failed records (`ok: false`) are
 * excluded from the totals because the budget gate should not count failed
 * calls against the user's quota.
 *
 * Day boundary: UTC date of `now`. Month boundary: year-month of `now`.
 * Records on the day == `now.getUTCDate()` AND month == `now.getUTCMonth()`
 * count toward `today`; all records in the same year-month count toward `month`.
 */
export function aggregateByProfile(
  records: UsageRecord[],
  now: Date,
): Record<string, ProfileUsageEntry> {
  const todayYmd = now.toISOString().slice(0, 10);    // "YYYY-MM-DD"
  const monthYm  = now.toISOString().slice(0, 7);     // "YYYY-MM"

  const out: Record<string, ProfileUsageEntry> = {};
  for (const r of records) {
    if (!r.ok) continue;
    const ts = r.timestamp;
    const inThisMonth = ts.startsWith(monthYm);
    if (!inThisMonth) continue;
    const inToday = ts.startsWith(todayYmd);

    const e = (out[r.profileId] ??= {
      today: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      month: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    e.month.calls += 1;
    e.month.inputTokens += r.inputTokens;
    e.month.outputTokens += r.outputTokens;
    e.month.costUsd += r.costUsd;
    if (inToday) {
      e.today.calls += 1;
      e.today.inputTokens += r.inputTokens;
      e.today.outputTokens += r.outputTokens;
      e.today.costUsd += r.costUsd;
    }
  }
  return out;
}
