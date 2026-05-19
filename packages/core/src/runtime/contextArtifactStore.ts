import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { ContextArtifactSchema } from "../context-compression/schema.js";
import type { ContextArtifact } from "../context-compression/types.js";

const ARTIFACTS_SUBDIR = ".tierkit/runtime/context-artifacts";
const GITIGNORE_PATH = ".tierkit/.gitignore";
const MAX_ID_RETRIES = 5;

export type ContextArtifactStoreErrorCode =
  | "not-found"
  | "schema-mismatch"
  | "id-collision";

export class ContextArtifactStoreError extends Error {
  code: ContextArtifactStoreErrorCode;
  constructor(code: ContextArtifactStoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ContextArtifactStoreError";
  }
}

export interface WriteArtifactOptions {
  /** Test-only: override the id generator (default = ctx_ + 10 hex chars). */
  idGenerator?: () => string;
}

export interface WriteArtifactResult {
  id: string;
  dir: string;
}

/** Mints a fresh `ctx_<10 hex>` id. Exported so callers (e.g. `buildCompressedContext`)
 * can share the same format without duplicating the implementation. */
export function defaultIdGenerator(): string {
  return "ctx_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

const ID_FORMAT = /^ctx_[a-f0-9]{10}$/;

function artifactDir(workspaceRoot: string, id: string): string {
  return path.join(workspaceRoot, ARTIFACTS_SUBDIR, id);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function ensureGitignore(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, GITIGNORE_PATH);
  try {
    await fs.access(target);
    return; // exists — never overwrite
  } catch {
    // continue
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "*\n");
}

export async function writeArtifact(
  workspaceRoot: string,
  artifact: ContextArtifact,
  promptMd: string,
  opts: WriteArtifactOptions = {},
): Promise<WriteArtifactResult> {
  const gen = opts.idGenerator ?? defaultIdGenerator;
  let chosenId = "";
  let chosenDir = "";

  // First, try the caller's id as a hint: if it's well-formed and the directory
  // doesn't already exist, use it. This avoids wasted regeneration in the common
  // case where the caller minted an id alongside the artifact.
  const callerId = artifact.id;
  if (ID_FORMAT.test(callerId)) {
    const dir = artifactDir(workspaceRoot, callerId);
    if (!(await dirExists(dir))) {
      chosenId = callerId;
      chosenDir = dir;
    }
  }

  // Fall back to the generator on collision or when the caller's id is missing/invalid.
  if (!chosenId) {
    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt += 1) {
      const id = gen();
      const dir = artifactDir(workspaceRoot, id);
      if (!(await dirExists(dir))) {
        chosenId = id;
        chosenDir = dir;
        break;
      }
    }
  }
  if (!chosenId) {
    throw new ContextArtifactStoreError(
      "id-collision",
      `failed to generate a unique artifact id after ${MAX_ID_RETRIES} attempts`,
    );
  }
  const finalized: ContextArtifact = { ...artifact, id: chosenId };
  await fs.mkdir(chosenDir, { recursive: true });
  await fs.writeFile(path.join(chosenDir, "artifact.json"), JSON.stringify(finalized, null, 2));
  await fs.writeFile(path.join(chosenDir, "prompt.md"), promptMd);
  await ensureGitignore(workspaceRoot);
  return { id: chosenId, dir: chosenDir };
}

export interface ReadArtifactResult {
  artifact: ContextArtifact;
  promptMd: string;
  dir: string;
}

export async function readArtifact(workspaceRoot: string, id: string): Promise<ReadArtifactResult> {
  const dir = artifactDir(workspaceRoot, id);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "artifact.json"), "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new ContextArtifactStoreError("not-found", `artifact "${id}" not found at ${dir}`);
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ContextArtifactStoreError("schema-mismatch", `artifact.json is not valid JSON at ${dir}`);
  }
  const parsed = ContextArtifactSchema.safeParse(json);
  if (!parsed.success) {
    throw new ContextArtifactStoreError(
      "schema-mismatch",
      `artifact.json schema mismatch at ${dir}: ${parsed.error.message}`,
    );
  }
  let promptMd = "";
  try {
    promptMd = await fs.readFile(path.join(dir, "prompt.md"), "utf8");
  } catch {
    // prompt.md missing → treat as empty rather than fail; surface in caller.
  }
  return { artifact: parsed.data, promptMd, dir };
}

export async function mutateArtifact(
  workspaceRoot: string,
  artifact: ContextArtifact,
): Promise<void> {
  const dir = artifactDir(workspaceRoot, artifact.id);
  if (!(await dirExists(dir))) {
    throw new ContextArtifactStoreError("not-found", `cannot mutate: artifact ${artifact.id} not found`);
  }
  await fs.writeFile(path.join(dir, "artifact.json"), JSON.stringify(artifact, null, 2));
}

export function artifactRelativePath(workspaceRoot: string, id: string, file: string): string {
  return path.relative(workspaceRoot, path.join(artifactDir(workspaceRoot, id), file));
}
