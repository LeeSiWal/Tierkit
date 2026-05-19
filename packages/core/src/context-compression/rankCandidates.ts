import path from "node:path";
import type { RelevantFile, SourceLanguage } from "./types.js";

export interface CandidateInput {
  path: string;
  matchedTerms: string[];
  termHitCount: number;
  sizeBytes: number;
  mtimeMs: number;
}

export interface RankCandidatesInput {
  candidates: CandidateInput[];
  keywords: string[];
  maxFiles: number;
  now: number;
}

const EXT_TO_LANG: Record<string, SourceLanguage> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".md": "md",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "sh",
};

function languageOf(filePath: string): SourceLanguage {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? "other";
}

function termHitScore(termHitCount: number): number {
  // log1p normalization → 0..0.7
  // log1p(10) ≈ 2.4 → ~0.7 cap
  return Math.min(0.7, Math.log1p(termHitCount) * 0.3);
}

function computePathBonus(filePath: string, keywords: string[]): number {
  const lower = filePath.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return 0.15;
  }
  return 0;
}

function computeMtimeBonus(mtimeMs: number, now: number): number {
  const ageDays = Math.max(0, (now - mtimeMs) / 86_400_000);
  return 0.15 * Math.exp(-ageDays / 30);
}

function buildReason(matchedTerms: string[], pathBonus: number, mtimeBonus: number): string {
  const parts: string[] = [];
  parts.push(`matched [${matchedTerms.join(", ")}]`);
  if (pathBonus > 0) parts.push("in path");
  if (mtimeBonus > 0.1) parts.push("recent edit");
  return parts.join(", ");
}

export function rankCandidates(input: RankCandidatesInput): RelevantFile[] {
  const { candidates, keywords, maxFiles, now } = input;

  const scored = candidates.map((c) => {
    const hits = termHitScore(c.termHitCount);
    const pathB = computePathBonus(c.path, keywords);
    const mtimeB = computeMtimeBonus(c.mtimeMs, now);
    const total = Math.min(1, hits + pathB + mtimeB);
    const rf: RelevantFile = {
      path: c.path,
      score: total,
      reason: buildReason(c.matchedTerms, pathB, mtimeB),
      matchedTerms: c.matchedTerms,
      termHitCount: c.termHitCount,
      pathBonus: pathB,
      mtimeBonus: mtimeB,
      sizeBytes: c.sizeBytes,
      language: languageOf(c.path),
    };
    return rf;
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  return scored.slice(0, maxFiles);
}
