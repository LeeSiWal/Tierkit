import path from "node:path";
import fs from "node:fs/promises";
import { defaultIdGenerator } from "../runtime/contextArtifactStore.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_IGNORE_GLOBS,
  type ContextArtifact,
  type ContextBudget,
  type FileExcerpt,
} from "../context-compression/types.js";
import { extractKeywords } from "../context-compression/extractKeywords.js";
import {
  collectCandidates,
  defaultRgRunner,
  type RgRunner,
} from "../context-compression/collectCandidates.js";
import { rankCandidates, type CandidateInput } from "../context-compression/rankCandidates.js";
import { extractSkeleton } from "../context-compression/extractSkeleton.js";
import { extractHotspots } from "../context-compression/extractHotspots.js";
import { buildPromptMd } from "../context-compression/buildPromptMd.js";
import { estimateTokens } from "../context-compression/estimateTokens.js";

export interface BuildCompressedContextInput {
  task: string;
  workspaceRoot: string;
  budget?: Partial<ContextBudget>;
  extraIgnoreGlobs?: string[];
  /** Injectable rg runner for tests. */
  rg?: RgRunner;
}

export type BuildCompressedContextResult =
  | { ok: true; artifact: ContextArtifact; promptMd: string }
  | {
      ok: false;
      code: "rg-missing" | "no-keywords" | "no-candidates" | "workspace-not-found";
      message: string;
    };

function resolveBudget(override?: Partial<ContextBudget>): ContextBudget {
  return {
    maxFiles: override?.maxFiles ?? DEFAULT_CONTEXT_BUDGET.maxFiles,
    maxHotspotsPerFile: override?.maxHotspotsPerFile ?? DEFAULT_CONTEXT_BUDGET.maxHotspotsPerFile,
    hotspotContextLines: override?.hotspotContextLines ?? DEFAULT_CONTEXT_BUDGET.hotspotContextLines,
    ...(override?.cloudTokenBudget !== undefined ? { cloudTokenBudget: override.cloudTokenBudget } : {}),
  };
}

function resolveIgnoreGlobs(extra?: string[]): string[] {
  const set = new Set<string>(DEFAULT_IGNORE_GLOBS);
  for (const g of extra ?? []) set.add(g);
  return [...set];
}

export async function buildCompressedContext(
  input: BuildCompressedContextInput,
): Promise<BuildCompressedContextResult> {
  // 0. Verify workspace exists.
  try {
    const st = await fs.stat(input.workspaceRoot);
    if (!st.isDirectory()) {
      return {
        ok: false,
        code: "workspace-not-found",
        message: `workspaceRoot is not a directory: ${input.workspaceRoot}`,
      };
    }
  } catch {
    return {
      ok: false,
      code: "workspace-not-found",
      message: `workspaceRoot does not exist: ${input.workspaceRoot}`,
    };
  }

  // 1. Resolve budget + ignore globs.
  const budget = resolveBudget(input.budget);
  const ignoreGlobs = resolveIgnoreGlobs(input.extraIgnoreGlobs);

  // 2. Extract keywords.
  const keywords = extractKeywords(input.task);
  if (keywords.length === 0) {
    return {
      ok: false,
      code: "no-keywords",
      message: "task contains no extractable keywords (all stopwords or too generic). Try more specific terms.",
    };
  }

  // 3. Collect candidates via rg.
  const collectResult = await collectCandidates({
    workspaceRoot: input.workspaceRoot,
    keywords,
    ignoreGlobs,
    rg: input.rg ?? defaultRgRunner,
  });
  if (!collectResult.ok) {
    return { ok: false, code: collectResult.code, message: collectResult.message };
  }

  // 4. Fetch file stats for ranking.
  const rankInputs: CandidateInput[] = [];
  for (const c of collectResult.candidates) {
    try {
      const st = await fs.stat(path.join(input.workspaceRoot, c.path));
      rankInputs.push({
        path: c.path,
        matchedTerms: c.matchedTerms,
        termHitCount: c.termHitCount,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // file vanished or unreadable; skip
    }
  }

  // 5. Rank.
  const ranked = rankCandidates({
    candidates: rankInputs,
    keywords,
    maxFiles: budget.maxFiles,
    now: Date.now(),
  });

  // 6. Per-file: read + skeleton + hotspots → FileExcerpt.
  const excerpts: FileExcerpt[] = [];
  let baselineCharCount = input.task.length;
  for (const file of ranked) {
    const abs = path.join(input.workspaceRoot, file.path);
    let content = "";
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    baselineCharCount += content.length;
    const lang = file.language ?? "other";
    const skeleton = extractSkeleton(content, lang);
    const { hotspots, omittedLineRanges } = extractHotspots(content, keywords, {
      maxHotspots: budget.maxHotspotsPerFile,
      contextLines: budget.hotspotContextLines,
    });
    const rendered = [
      ...skeleton.map((s) => s.text),
      ...hotspots.map((h) => h.code),
    ].join("\n");
    excerpts.push({
      path: file.path,
      language: lang,
      totalLines: content.split("\n").length,
      skeleton,
      hotspots,
      omittedLineRanges,
      estimatedTokens: estimateTokens(rendered),
    });
  }

  // 7. Build prompt.md.
  const promptMd = buildPromptMd({ task: input.task, relevantFiles: ranked, excerpts });

  // Note: baselineCharCount is the byte count of (task + selected files raw). We use
  // Math.ceil(.../ 4) directly here instead of allocating a placeholder string just
  // to call estimateTokens — same result, no wasted allocation.
  const estimatedBaselineInputTokens = Math.ceil(baselineCharCount / 4);
  const estimatedCompressedInputTokens = estimateTokens(promptMd);
  const savedTokensEstimate = estimatedBaselineInputTokens - estimatedCompressedInputTokens;
  const compressionRatio =
    estimatedBaselineInputTokens > 0
      ? estimatedCompressedInputTokens / estimatedBaselineInputTokens
      : 1;

  const artifact: ContextArtifact = {
    id: defaultIdGenerator(),
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workspaceRoot: input.workspaceRoot,
    task: input.task,
    keywords,
    budget,
    ignoreGlobs,
    candidates: ranked,
    excerpts,
    promptMdPath: "prompt.md",
    estimatedBaselineInputTokens,
    estimatedCompressedInputTokens,
    savedTokensEstimate,
    compressionRatio,
  };

  return { ok: true, artifact, promptMd };
}
