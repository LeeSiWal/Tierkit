/**
 * MCP tool wrappers for the v0.18 context-gateway digest pipeline.
 *
 * Each tool is a thin adapter: validate args → call into `@tierkit/core`
 * digest function → wrap result in the v0.16 tool-result-envelope. They
 * intentionally do NOT recompute or duplicate the digest logic.
 */
import path from "node:path";
import {
  buildContextPack,
  compressCommand,
  compressErrorLog,
  compressJson,
  compressTestOutput,
  getFileDigestCached,
  makeFailureEnvelope,
  makeSuccessEnvelope,
  summarizeGitDiff,
  type CompressedCommand,
  type ContextPack,
  type DiffSummary,
  type ErrorDigest,
  type FileDigest,
  type JsonDigest,
  type TestDigest,
} from "@tierkit/core";

interface ToolCtx {
  workspaceRoot: string;
}

function badArgs(toolName: string, message: string) {
  return makeFailureEnvelope(toolName, "invalid-args", message);
}

function isStringArg(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ----- tierkit.compress_command -----

export async function compressCommandTool(args: Record<string, unknown>, _ctx: ToolCtx) {
  const tool = "tierkit.compress_command";
  if (!isStringArg(args.command)) return badArgs(tool, "missing required parameter `command` (string)");
  const result: CompressedCommand = await compressCommand(args.command);
  return makeSuccessEnvelope(tool, {
    id: result.id,
    taskTitle: result.taskTitle,
    compressed: result.compressed,
    requirements: result.requirements,
    constraints: result.constraints,
    likelyFocus: result.likelyFocus,
    uncertainty: result.uncertainty,
    stats: result.stats,
    provider: result.provider,
    model: result.model,
    verdict: result.verdict,
  });
}

// ----- tierkit.get_error_digest -----

export async function getErrorDigestTool(args: Record<string, unknown>, _ctx: ToolCtx) {
  const tool = "tierkit.get_error_digest";
  if (!isStringArg(args.log)) return badArgs(tool, "missing required parameter `log` (string)");
  const result: ErrorDigest = compressErrorLog(args.log);
  return makeSuccessEnvelope(tool, {
    id: result.id,
    summaryMd: result.summaryMd,
    mainErrors: result.mainErrors,
    likelyFiles: result.likelyFiles,
    likelySymbols: result.likelySymbols,
    uncertainty: result.uncertainty,
    stats: result.stats,
    verdict: result.verdict,
  });
}

// ----- tierkit.get_test_digest -----

export async function getTestDigestTool(args: Record<string, unknown>, _ctx: ToolCtx) {
  const tool = "tierkit.get_test_digest";
  if (!isStringArg(args.output)) return badArgs(tool, "missing required parameter `output` (string)");
  const result: TestDigest = compressTestOutput(args.output);
  return makeSuccessEnvelope(tool, {
    id: result.id,
    summaryMd: result.summaryMd,
    passedCount: result.passedCount,
    failedCount: result.failedCount,
    failedSuites: result.failedSuites,
    failedCases: result.failedCases,
    likelyFiles: result.likelyFiles,
    uncertainty: result.uncertainty,
    stats: result.stats,
    verdict: result.verdict,
  });
}

// ----- tierkit.get_json_digest -----

export async function getJsonDigestTool(args: Record<string, unknown>, _ctx: ToolCtx) {
  const tool = "tierkit.get_json_digest";
  if (!isStringArg(args.json)) return badArgs(tool, "missing required parameter `json` (string)");
  const result: JsonDigest = compressJson(args.json);
  return makeSuccessEnvelope(tool, {
    id: result.id,
    summaryMd: result.summaryMd,
    fieldPaths: result.fieldPaths,
    shape: result.shape,
    possibleMismatches: result.possibleMismatches,
    uncertainty: result.uncertainty,
    stats: result.stats,
    verdict: result.verdict,
  });
}

// ----- tierkit.get_file_digest -----

function isInsideWorkspace(workspaceRoot: string, filePath: string): boolean {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
  const rel = path.relative(workspaceRoot, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function getFileDigestTool(args: Record<string, unknown>, ctx: ToolCtx) {
  const tool = "tierkit.get_file_digest";
  if (!isStringArg(args.path)) return badArgs(tool, "missing required parameter `path` (string)");
  if (!isInsideWorkspace(ctx.workspaceRoot, args.path)) {
    return makeFailureEnvelope(tool, "outside-workspace", `path ${args.path} resolves outside workspaceRoot`);
  }
  const result: FileDigest = await getFileDigestCached(args.path, {
    workspaceRoot: ctx.workspaceRoot,
    forceRefresh: args.forceRefresh === true,
  });
  return makeSuccessEnvelope(tool, {
    id: result.id,
    path: result.path,
    hash: result.hash,
    language: result.language,
    purpose: result.purpose,
    importantSymbols: result.importantSymbols,
    dependencies: result.dependencies,
    risks: result.risks,
    uncertainty: result.uncertainty,
    summaryMd: result.summaryMd,
    totalLines: result.totalLines,
    cacheHit: result.cacheHit,
    generatedAt: result.generatedAt,
    stats: result.stats,
  });
}

// ----- tierkit.get_diff_summary -----

export async function getDiffSummaryTool(args: Record<string, unknown>, ctx: ToolCtx) {
  const tool = "tierkit.get_diff_summary";
  const result: DiffSummary = await summarizeGitDiff(ctx.workspaceRoot, {
    staged: args.staged === true,
  });
  return makeSuccessEnvelope(tool, {
    id: result.id,
    summaryMd: result.summaryMd,
    changedFiles: result.changedFiles,
    addedFiles: result.addedFiles,
    modifiedFiles: result.modifiedFiles,
    deletedFiles: result.deletedFiles,
    renamedFiles: result.renamedFiles,
    affectedSymbols: result.affectedSymbols,
    possibleBreakages: result.possibleBreakages,
    totalInsertions: result.totalInsertions,
    totalDeletions: result.totalDeletions,
    uncertainty: result.uncertainty,
    stats: result.stats,
  });
}

// ----- tierkit.build_context_pack -----

function stringArrayOrEmpty(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export async function buildContextPackTool(args: Record<string, unknown>, ctx: ToolCtx) {
  const tool = "tierkit.build_context_pack";
  const files = stringArrayOrEmpty(args.files);
  for (const f of files) {
    if (!isInsideWorkspace(ctx.workspaceRoot, f)) {
      return makeFailureEnvelope(tool, "outside-workspace", `path ${f} resolves outside workspaceRoot`);
    }
  }
  const result: ContextPack = await buildContextPack({
    workspaceRoot: ctx.workspaceRoot,
    command: typeof args.command === "string" ? args.command : undefined,
    files: files.length > 0 ? files : undefined,
    includeDiff: args.includeDiff === true,
    stagedDiff: args.stagedDiff === true,
    errorLog: typeof args.errorLog === "string" ? args.errorLog : undefined,
    testOutput: typeof args.testOutput === "string" ? args.testOutput : undefined,
    jsonInput: typeof args.jsonInput === "string" ? args.jsonInput : undefined,
    rawContext: typeof args.rawContext === "string" ? args.rawContext : undefined,
  });
  return makeSuccessEnvelope(tool, {
    id: result.id,
    title: result.title,
    contentMd: result.contentMd,
    taskBrief: result.taskBrief,
    requirements: result.requirements,
    constraints: result.constraints,
    relevantFileDigests: result.relevantFileDigests.map((d) => ({
      path: d.path,
      hash: d.hash,
      cacheHit: d.cacheHit,
      stats: d.stats,
    })),
    diffSummary: result.diffSummary
      ? {
          changedFiles: result.diffSummary.changedFiles,
          addedFiles: result.diffSummary.addedFiles,
          modifiedFiles: result.diffSummary.modifiedFiles,
          deletedFiles: result.diffSummary.deletedFiles,
          renamedFiles: result.diffSummary.renamedFiles,
          totalInsertions: result.diffSummary.totalInsertions,
          totalDeletions: result.diffSummary.totalDeletions,
        }
      : undefined,
    errorDigestId: result.errorDigest?.id,
    testDigestId: result.testDigest?.id,
    jsonDigestId: result.jsonDigest?.id,
    uncertainty: result.uncertainty,
    outputPolicy: result.outputPolicy,
    stats: result.stats,
    provider: result.provider,
    model: result.model,
    verdict: result.verdict,
    createdAt: result.createdAt,
  });
}
