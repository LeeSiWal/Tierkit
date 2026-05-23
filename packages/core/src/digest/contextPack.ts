/**
 * buildContextPack — the v0.18 orchestrator.
 *
 * Given any combination of (command, files, diff, error log, test output, JSON,
 * raw context), this function calls each individual digest function and stitches
 * the results into one Markdown payload that Claude Code can consume directly.
 *
 * Think of it as the "compose" of the digest pipeline:
 *
 *   buildContextPack({
 *     workspaceRoot,
 *     command:    "Add CRUD for AdminMenuForm",
 *     files:      ["src/components/AdminMenuForm.tsx"],
 *     includeDiff: true,
 *     errorLog:   <stderr of npm run build>,
 *   })
 *     ↓
 *   ContextPack {
 *     contentMd: "# Tierkit Context Pack\n## Task Brief ...",
 *     stats: { savedTokens: 9421, savedRatio: 0.88, ... },
 *     ...
 *   }
 *
 * What this file does NOT do:
 *   - Talk to an LLM (unless `options.commandRefine` is given — that's
 *     compressCommand's optional refine pass).
 *   - Persist anything to disk. Pack stays in memory; CLI / Extension
 *     decides whether to save it.
 *   - Validate file paths. Workspace-boundary checks happen at the daemon
 *     and MCP layers (Server.ts + digestTools.ts).
 *
 * Reading order for a new contributor:
 *   1. Look at the `BuildContextPackInput` interface below.
 *   2. Skim `buildContextPack()` top-to-bottom — it's a straight pipeline.
 *   3. Then dive into whichever digest function you need to change
 *      (errorLog.ts / testOutput.ts / fileDigest.ts / ...).
 */
import { compressCommand, type CompressCommandOptions } from "./command.js";
import { compressErrorLog } from "./errorLog.js";
import { compressTestOutput } from "./testOutput.js";
import { compressJson } from "./jsonCompress.js";
import { cleanContext } from "./cleanContext.js";
import { summarizeGitDiff, type SummarizeGitDiffOptions } from "./gitDiff.js";
import { getFileDigestCached } from "./fileDigest.js";
import {
  CONTEXT_PACK_OUTPUT_POLICY,
  DEFAULT_DIGEST_BUDGET,
  type ContextPack,
  type DigestBudget,
  type FileDigest,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

export interface BuildContextPackInput {
  workspaceRoot: string;
  command?: string;
  files?: string[];
  includeDiff?: boolean;
  stagedDiff?: boolean;
  errorLog?: string;
  testOutput?: string;
  jsonInput?: string;
  rawContext?: string;
}

export interface BuildContextPackOptions {
  budget?: Partial<DigestBudget>;
  /** Title override; default is derived from the command. */
  title?: string;
  /** LLM refinement for the command (rule-only by default). */
  commandRefine?: CompressCommandOptions["refine"];
  /** Provider tag (for stats / reporting). */
  provider?: string;
  /** Provider's model name (for stats / reporting). */
  model?: string;
  /** Custom diff runner (test injection). */
  diffRunner?: SummarizeGitDiffOptions["diffRunner"];
}

export async function buildContextPack(
  input: BuildContextPackInput,
  options: BuildContextPackOptions = {},
): Promise<ContextPack> {
  const budget = { ...DEFAULT_DIGEST_BUDGET, ...options.budget };

  // 1. Task brief.
  const command = input.command?.trim() ?? "";
  const compressedCommand = command.length > 0
    ? await compressCommand(command, {
        budget,
        refine: options.commandRefine,
        model: options.model,
        provider: options.commandRefine ? "ollama" : "rule",
      })
    : null;

  const title = options.title
    ?? compressedCommand?.taskTitle
    ?? "Tierkit Context Pack";

  // 2. File digests.
  const relevantFileDigests: FileDigest[] = [];
  for (const f of input.files ?? []) {
    const d = await getFileDigestCached(f, { workspaceRoot: input.workspaceRoot, budget });
    relevantFileDigests.push(d);
  }

  // 3. Diff summary (optional).
  const diffSummary = input.includeDiff
    ? await summarizeGitDiff(input.workspaceRoot, {
        staged: input.stagedDiff,
        budget,
        diffRunner: options.diffRunner,
      })
    : undefined;

  // 4. Error / test / JSON digests.
  const errorDigest = input.errorLog
    ? compressErrorLog(input.errorLog, { budget })
    : undefined;
  const testDigest = input.testOutput
    ? compressTestOutput(input.testOutput, { budget })
    : undefined;
  const jsonDigest = input.jsonInput
    ? compressJson(input.jsonInput, { budget })
    : undefined;

  // 5. Cleaned raw context (optional).
  const cleanedContext = input.rawContext
    ? cleanContext(input.rawContext, { budget })
    : undefined;

  // 6. Aggregate uncertainty.
  const uncertainty: string[] = [];
  if (compressedCommand) uncertainty.push(...compressedCommand.uncertainty);
  for (const f of relevantFileDigests) uncertainty.push(...f.uncertainty);
  if (diffSummary) uncertainty.push(...diffSummary.uncertainty);
  if (errorDigest) uncertainty.push(...errorDigest.uncertainty);
  if (testDigest) uncertainty.push(...testDigest.uncertainty);
  if (jsonDigest) uncertainty.push(...jsonDigest.uncertainty);

  // 7. Render Markdown.
  const contentMd = renderContextPackMd({
    title,
    compressedCommand,
    relevantFileDigests,
    diffSummary,
    errorDigest,
    testDigest,
    jsonDigest,
    cleanedContext,
    uncertainty,
    outputPolicy: CONTEXT_PACK_OUTPUT_POLICY,
  });

  // 8. Compute aggregate stats.
  // Baseline = what the user would have sent without Tierkit: command + raw
  // context + raw error/test/json + every selected file's full source.
  // After = the generated Context Pack Markdown.
  //
  // Each file digest exposes the source's char count via `stats.beforeChars`
  // (computed inside getFileDigest before compression). Summing those gives a
  // realistic "before" — which is what makes the savings figure meaningful in
  // the common case where the user would have pasted the whole file otherwise.
  let baselineChars =
    (command ?? "").length +
    (input.rawContext ?? "").length +
    (input.errorLog ?? "").length +
    (input.testOutput ?? "").length +
    (input.jsonInput ?? "").length;
  for (const f of relevantFileDigests) {
    baselineChars += f.stats.beforeChars;
  }
  // Reuse computeStats by passing a synthetic baseline string of the right length.
  // Cheaper than reading file contents twice — the estimator only cares about length.
  const stats = computeStats("x".repeat(baselineChars), contentMd);

  return {
    id: makeDigestId("pack"),
    title,
    taskBrief: compressedCommand?.compressed ?? "",
    requirements: compressedCommand?.requirements ?? [],
    constraints: compressedCommand?.constraints ?? [],
    relevantFileDigests,
    diffSummary,
    errorDigest,
    testDigest,
    jsonDigest,
    cleanedContext,
    uncertainty,
    outputPolicy: CONTEXT_PACK_OUTPUT_POLICY,
    contentMd,
    stats,
    provider: options.provider ?? (options.commandRefine ? "ollama" : "rule"),
    model: options.model,
    verdict: "not-evaluated",
    createdAt: new Date().toISOString(),
  };
}

interface RenderInput {
  title: string;
  compressedCommand: Awaited<ReturnType<typeof compressCommand>> | null;
  relevantFileDigests: FileDigest[];
  diffSummary?: ContextPack["diffSummary"];
  errorDigest?: ContextPack["errorDigest"];
  testDigest?: ContextPack["testDigest"];
  jsonDigest?: ContextPack["jsonDigest"];
  cleanedContext?: ContextPack["cleanedContext"];
  uncertainty: string[];
  outputPolicy: string[];
}

function renderContextPackMd(r: RenderInput): string {
  const lines: string[] = [];
  lines.push(`# Tierkit Context Pack`);
  lines.push("");
  lines.push(`**Title:** ${r.title}`);
  lines.push("");

  if (r.compressedCommand) {
    lines.push("## Task Brief");
    lines.push(r.compressedCommand.compressed);
    lines.push("");
  }

  if (r.relevantFileDigests.length > 0) {
    lines.push("## Relevant File Digests");
    for (const f of r.relevantFileDigests) {
      lines.push("");
      lines.push(`### ${f.path}${f.cacheHit ? " _(cached)_" : ""}`);
      lines.push(f.summaryMd
        .split("\n")
        .filter((l) => !l.startsWith("# File Digest:"))
        .join("\n")
        .trim());
    }
    lines.push("");
  }

  if (r.diffSummary) {
    lines.push("## Recent Git Diff Summary");
    lines.push(r.diffSummary.summaryMd.replace(/^# Diff Summary\s*\n?/, "").trim());
    lines.push("");
  }

  if (r.errorDigest) {
    lines.push("## Error Digest");
    lines.push(r.errorDigest.summaryMd.replace(/^# Error Digest\s*\n?/, "").trim());
    lines.push("");
  }

  if (r.testDigest) {
    lines.push("## Test Digest");
    lines.push(r.testDigest.summaryMd.replace(/^# Test Digest\s*\n?/, "").trim());
    lines.push("");
  }

  if (r.jsonDigest) {
    lines.push("## JSON / API Digest");
    lines.push(r.jsonDigest.summaryMd.replace(/^# JSON Digest\s*\n?/, "").trim());
    lines.push("");
  }

  if (r.cleanedContext) {
    lines.push("## Cleaned Raw Context");
    if (r.cleanedContext.removedHints.length > 0) {
      lines.push(`_${r.cleanedContext.removedHints.join("; ")}_`);
      lines.push("");
    }
    lines.push("```");
    lines.push(r.cleanedContext.cleaned);
    lines.push("```");
    lines.push("");
  }

  if (r.uncertainty.length > 0) {
    lines.push("## Uncertainty and Verification Required");
    for (const u of r.uncertainty) lines.push(`- ${u}`);
    lines.push("");
  }

  lines.push("## Output Policy for Claude Code");
  for (const p of r.outputPolicy) lines.push(`- ${p}`);

  return lines.join("\n");
}
