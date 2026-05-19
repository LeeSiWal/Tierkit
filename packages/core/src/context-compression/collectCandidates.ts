import { spawn } from "node:child_process";

export interface CandidateMatch {
  path: string;
  matchedTerms: string[];
  termHitCount: number;
}

export type CollectCandidatesResult =
  | { ok: true; candidates: CandidateMatch[] }
  | { ok: false; code: "rg-missing" | "no-candidates"; message: string };

export interface RgRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable rg runner for tests. */
export type RgRunner = (args: string[], cwd?: string) => Promise<RgRunResult>;

export const defaultRgRunner: RgRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

export interface CollectCandidatesInput {
  workspaceRoot: string;
  keywords: string[];
  ignoreGlobs: string[];
  /** Injectable rg runner; defaults to spawning `rg`. */
  rg?: RgRunner;
}

const RG_MISSING_MSG = [
  "ripgrep (rg) is required for `tierkit context build`.",
  "Install:",
  "  macOS:  brew install ripgrep",
  "  Linux:  apt install ripgrep",
  "  Win:    choco install ripgrep",
].join("\n");

function buildGlobArgs(ignoreGlobs: string[]): string[] {
  const args: string[] = [];
  for (const g of ignoreGlobs) {
    args.push("--glob", `!${g}`);
  }
  return args;
}

export async function collectCandidates(
  input: CollectCandidatesInput,
): Promise<CollectCandidatesResult> {
  const rg = input.rg ?? defaultRgRunner;
  const { workspaceRoot, keywords, ignoreGlobs } = input;

  const byPath = new Map<string, CandidateMatch>();

  // 1. Per-keyword content search.
  for (const kw of keywords) {
    let result: RgRunResult;
    try {
      result = await rg(
        ["--files-with-matches", "--ignore-case", ...buildGlobArgs(ignoreGlobs), "--", kw, "."],
        workspaceRoot,
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return { ok: false, code: "rg-missing", message: RG_MISSING_MSG };
      }
      throw err;
    }
    if (result.code !== 0 && result.code !== 1) {
      // rg exits 1 when no matches — that's fine; other codes are errors.
      continue;
    }
    const paths = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const p of paths) {
      const existing = byPath.get(p);
      if (existing) {
        if (!existing.matchedTerms.includes(kw)) {
          existing.matchedTerms.push(kw);
          existing.termHitCount += 1;
        }
      } else {
        byPath.set(p, { path: p, matchedTerms: [kw], termHitCount: 1 });
      }
    }
  }

  // 2. Filename-match pass via --files.
  let listingResult: RgRunResult;
  try {
    listingResult = await rg(["--files", ...buildGlobArgs(ignoreGlobs)], workspaceRoot);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ok: false, code: "rg-missing", message: RG_MISSING_MSG };
    }
    throw err;
  }
  if (listingResult.code === 0 || listingResult.code === 1) {
    const allPaths = listingResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const p of allPaths) {
      const lower = p.toLowerCase();
      const filenameMatches = keywords.filter((kw) => lower.includes(kw.toLowerCase()));
      if (filenameMatches.length === 0) continue;
      const existing = byPath.get(p);
      if (existing) {
        for (const kw of filenameMatches) {
          if (!existing.matchedTerms.includes(kw)) {
            existing.matchedTerms.push(kw);
            existing.termHitCount += 1;
          }
        }
      } else {
        byPath.set(p, { path: p, matchedTerms: filenameMatches, termHitCount: filenameMatches.length });
      }
    }
  }

  const candidates = [...byPath.values()];
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "no-candidates",
      message: "No candidate files found. Try more specific terms or fewer --ignore patterns.",
    };
  }
  return { ok: true, candidates };
}
