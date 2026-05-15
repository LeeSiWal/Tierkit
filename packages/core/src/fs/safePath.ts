import path from "node:path";
import { TierkitError } from "../errors/TierkitError.js";

export class PathTraversalError extends TierkitError {
  public readonly base: string;
  public readonly attempted: string;
  constructor(base: string, attempted: string) {
    super(
      `path traversal blocked: "${attempted}" resolves outside the allowed base directory "${base}"`,
    );
    this.name = "PathTraversalError";
    this.base = base;
    this.attempted = attempted;
  }
}

/**
 * Resolve `relative` under `baseDir`, refusing any result that escapes the base directory.
 * Absolute paths in `relative` are rejected as well — only base-relative paths are allowed.
 */
export function resolveUnder(baseDir: string, relative: string): string {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new PathTraversalError(baseDir, relative);
  }
  if (path.isAbsolute(relative)) {
    throw new PathTraversalError(baseDir, relative);
  }

  const normalizedBase = path.resolve(baseDir);
  const candidate = path.resolve(normalizedBase, relative);

  const rel = path.relative(normalizedBase, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathTraversalError(baseDir, relative);
  }
  return candidate;
}

export function isWithin(baseDir: string, candidate: string): boolean {
  const normalizedBase = path.resolve(baseDir);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedBase === normalizedCandidate) return true;
  const rel = path.relative(normalizedBase, normalizedCandidate);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
