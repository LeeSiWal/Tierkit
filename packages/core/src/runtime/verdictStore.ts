import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { readArtifact, ContextArtifactStoreError } from "./contextArtifactStore.js";

const ARTIFACTS_SUBDIR = ".tierkit/runtime/context-artifacts";

export const QUALITY_VERDICTS = ["same", "better", "worse", "unusable"] as const;
export type QualityVerdict = (typeof QUALITY_VERDICTS)[number];

/**
 * Human quality judgment on a context-compression compare result.
 *
 * qualityVerdict semantics:
 *   same     — compressed response preserves the SAME USEFUL OUTCOME as baseline.
 *              NOT text equality — phrasing/wording can differ freely.
 *   better   — compressed response is meaningfully better than baseline.
 *              Compression removed noise; reasoning clearer. Rare but observed.
 *   worse    — compressed response missed something baseline got, or introduced
 *              a wrong claim, but still partially useful.
 *   unusable — compressed response is materially wrong / misleading / would
 *              cause harm if acted on.
 *
 * Aggregated verdicts feed the validation-log compilation that gates v0.14
 * (local LLM rerank/compress) entry.
 */
export const VerdictSchema = z
  .object({
    artifactId:     z.string().regex(/^ctx_[a-f0-9]{10}$/),
    qualityVerdict: z.enum(QUALITY_VERDICTS),
    missingContext: z.boolean().optional(),
    notes:          z.string().max(2000).optional(),
    reviewedAt:     z.string().datetime(),
  })
  .strict();

export type ArtifactVerdict = z.infer<typeof VerdictSchema>;

export type VerdictStoreErrorCode =
  | "artifact-not-found"
  | "compare-not-run"
  | "schema-mismatch"
  | "not-found";

export class VerdictStoreError extends Error {
  code: VerdictStoreErrorCode;
  constructor(code: VerdictStoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "VerdictStoreError";
  }
}

function verdictPath(workspaceRoot: string, artifactId: string): string {
  return path.join(workspaceRoot, ARTIFACTS_SUBDIR, artifactId, "verdict.json");
}

/**
 * Read verdict.json sidecar. Returns null when the file is absent (NOT an error).
 * Returns null + logs warning on invalid JSON or schema mismatch (lenient — the
 * artifact view should not break because of a corrupted verdict).
 */
export async function readVerdict(
  workspaceRoot: string,
  artifactId: string,
): Promise<ArtifactVerdict | null> {
  const file = verdictPath(workspaceRoot, artifactId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`Warning: invalid verdict.json for ${artifactId} at ${file}; treating as no verdict.`);
    return null;
  }
  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`Warning: invalid verdict.json for ${artifactId} at ${file}; treating as no verdict.`);
    return null;
  }
  return result.data;
}

/**
 * Write the verdict. REQUIRES `artifact.json` exists AND has `compare !== undefined`.
 *
 * Server builds the verdict object internally:
 *   - artifactId comes from the function parameter (URL :id)
 *   - reviewedAt is server-stamped to ISO now
 * Callers cannot forge either.
 *
 * Atomic write: writes to `verdict.json.tmp`, then renames. Last-write-wins.
 */
export async function writeVerdict(
  workspaceRoot: string,
  artifactId: string,
  input: {
    qualityVerdict: QualityVerdict;
    missingContext?: boolean;
    notes?: string;
  },
): Promise<ArtifactVerdict> {
  let artifact;
  try {
    ({ artifact } = await readArtifact(workspaceRoot, artifactId));
  } catch (err) {
    if (err instanceof ContextArtifactStoreError && err.code === "not-found") {
      throw new VerdictStoreError(
        "artifact-not-found",
        `cannot write verdict: artifact ${artifactId} not found`,
      );
    }
    throw err;
  }
  if (artifact.compare === undefined) {
    throw new VerdictStoreError(
      "compare-not-run",
      `cannot write verdict for ${artifactId}: artifact has no compare result yet`,
    );
  }

  const verdict: ArtifactVerdict = VerdictSchema.parse({
    artifactId,
    qualityVerdict: input.qualityVerdict,
    ...(input.missingContext !== undefined ? { missingContext: input.missingContext } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    reviewedAt: new Date().toISOString(),
  });

  const file = verdictPath(workspaceRoot, artifactId);
  const tmpFile = file + ".tmp";
  await fs.writeFile(tmpFile, JSON.stringify(verdict, null, 2));
  await fs.rename(tmpFile, file);

  return verdict;
}
