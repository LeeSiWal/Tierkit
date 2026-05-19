import path from "node:path";
import fs from "node:fs/promises";
import { runRoute } from "./runRoute.js";
import { readArtifact, mutateArtifact } from "../runtime/contextArtifactStore.js";
import { estimateTokens } from "../context-compression/estimateTokens.js";
import type { RunMode } from "../context/TaskContextBuilder.js";
import type { StreamEvent } from "../model/providers/chatTypes.js";
import type {
  CompareResult,
  CompareSide,
  ContextArtifact,
} from "../context-compression/types.js";
import type { RouteRunner } from "./sendCompressedContext.js";

export interface CompareCompressedContextInput {
  workspaceRoot: string;
  id: string;
  profileId: string;
  mode?: RunMode;
  /** Emit deltas during streaming; if absent, output is fully buffered. */
  onBaselineDelta?: (text: string) => void;
  onCompressedDelta?: (text: string) => void;
  onPhase?: (phase: "baseline-start" | "baseline-end" | "compressed-start" | "compressed-end") => void;
}

export type CompareCompressedContextResult =
  | { ok: true; artifact: ContextArtifact; compare: CompareResult; overwrote: boolean }
  | { ok: false; code: string; message: string; phase: "baseline" | "compressed" };

async function buildBaselineMd(workspaceRoot: string, artifact: ContextArtifact): Promise<string> {
  const out: string[] = [];
  out.push("# Task");
  out.push("");
  out.push(artifact.task);
  out.push("");
  out.push("# Files");
  out.push("");
  for (const c of artifact.candidates) {
    out.push(`## File: ${c.path}`);
    out.push("");
    const fence = c.language && c.language !== "other" ? "```" + c.language : "```";
    out.push(fence);
    try {
      out.push(await fs.readFile(path.join(workspaceRoot, c.path), "utf8"));
    } catch {
      out.push(`(file unreadable: ${c.path})`);
    }
    out.push("```");
    out.push("");
  }
  return out.join("\n");
}

async function runOneSide(
  runner: RouteRunner,
  workspaceRoot: string,
  task: string,
  profileId: string,
  mode: RunMode,
  onDelta: ((t: string) => void) | undefined,
): Promise<
  | { ok: true; text: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; failureCode?: string }
  | { ok: false; code: string; message: string }
> {
  const r = await runner({ cwd: workspaceRoot, task, profileId, mode });
  if (!r.ok) return { ok: false, code: r.code, message: r.message };

  let buffered = "";
  let failureCode: string | undefined;
  for await (const evt of r.stream as AsyncIterable<StreamEvent>) {
    if (evt.type === "delta") {
      buffered += evt.text;
      onDelta?.(evt.text);
    } else if (evt.type === "error") {
      failureCode = evt.code;
    }
  }
  const done = await r.done;
  return {
    ok: true,
    text: buffered || done.text,
    inputTokens: done.inputTokens,
    outputTokens: done.outputTokens,
    costUsd: done.costUsd,
    latencyMs: done.latencyMs,
    ...(failureCode ? { failureCode } : {}),
  };
}

export async function compareCompressedContext(
  input: CompareCompressedContextInput,
  deps: { routeRunner?: RouteRunner } = {},
): Promise<CompareCompressedContextResult> {
  const runner = deps.routeRunner ?? runRoute;
  const mode: RunMode = input.mode ?? "execute";

  const { artifact, promptMd, dir } = await readArtifact(input.workspaceRoot, input.id);
  const overwrote = artifact.compare !== undefined;

  // Build baseline.md and write to disk.
  const baselineMd = await buildBaselineMd(artifact.workspaceRoot, artifact);
  const baselinePath = path.join(dir, "baseline.md");
  await fs.writeFile(baselinePath, baselineMd);
  const baselineEstimatedTokens = estimateTokens(baselineMd);

  // Phase 3 — baseline call.
  input.onPhase?.("baseline-start");
  const baselineResult = await runOneSide(
    runner,
    artifact.workspaceRoot,
    baselineMd,
    input.profileId,
    mode,
    input.onBaselineDelta,
  );
  if (!baselineResult.ok) {
    return { ok: false, code: baselineResult.code, message: baselineResult.message, phase: "baseline" };
  }
  await fs.writeFile(path.join(dir, "response-baseline.md"), baselineResult.text);
  input.onPhase?.("baseline-end");

  // Phase 4 — compressed call.
  input.onPhase?.("compressed-start");
  const compressedResult = await runOneSide(
    runner,
    artifact.workspaceRoot,
    promptMd,
    input.profileId,
    mode,
    input.onCompressedDelta,
  );
  if (!compressedResult.ok) {
    return { ok: false, code: compressedResult.code, message: compressedResult.message, phase: "compressed" };
  }
  await fs.writeFile(path.join(dir, "response-compressed.md"), compressedResult.text);
  input.onPhase?.("compressed-end");

  // Build compare result.
  const baselineSide: CompareSide = {
    inputPath: "baseline.md",
    estimatedInputTokens: baselineEstimatedTokens,
    actualInputTokens: baselineResult.inputTokens,
    actualOutputTokens: baselineResult.outputTokens,
    actualCostUsd: baselineResult.costUsd,
    latencyMs: baselineResult.latencyMs,
    responsePath: "response-baseline.md",
    ...(baselineResult.failureCode ? { failureCode: baselineResult.failureCode } : {}),
  };
  const compressedSide: CompareSide = {
    inputPath: "prompt.md",
    estimatedInputTokens: artifact.estimatedCompressedInputTokens,
    actualInputTokens: compressedResult.inputTokens,
    actualOutputTokens: compressedResult.outputTokens,
    actualCostUsd: compressedResult.costUsd,
    latencyMs: compressedResult.latencyMs,
    responsePath: "response-compressed.md",
    ...(compressedResult.failureCode ? { failureCode: compressedResult.failureCode } : {}),
  };
  const savedInputTokensEstimate =
    baselineEstimatedTokens - artifact.estimatedCompressedInputTokens;
  const savedInputTokensActual =
    baselineSide.actualInputTokens !== undefined && compressedSide.actualInputTokens !== undefined
      ? baselineSide.actualInputTokens - compressedSide.actualInputTokens
      : undefined;
  const savedCostUsdActual =
    baselineSide.actualCostUsd !== undefined && compressedSide.actualCostUsd !== undefined
      ? baselineSide.actualCostUsd - compressedSide.actualCostUsd
      : undefined;

  const compare: CompareResult = {
    ranAt: new Date().toISOString(),
    profileId: input.profileId,
    baseline: baselineSide,
    compressed: compressedSide,
    savedInputTokensEstimate,
    ...(savedInputTokensActual !== undefined ? { savedInputTokensActual } : {}),
    ...(savedCostUsdActual !== undefined ? { savedCostUsdActual } : {}),
  };

  const updated: ContextArtifact = {
    ...artifact,
    baselineMdPath: "baseline.md",
    baselineEstimatedTokens,
    compare,
  };
  await mutateArtifact(input.workspaceRoot, updated);

  return { ok: true, artifact: updated, compare, overwrote };
}
