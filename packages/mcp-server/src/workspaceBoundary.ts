import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a workspace-relative or absolute path. Returns the realpath of the
 * resolved path if it lies inside workspaceRoot (or equals it). Throws Error
 * with message containing "outside-workspace" otherwise. Callers should catch
 * and convert to an MCP error envelope.
 *
 * Symlinks are fully resolved so that a symlink inside the workspace that
 * points outside cannot bypass the boundary check.
 *
 * For paths that do not yet exist (e.g. new files proposed by propose_patch),
 * the function falls back to lexical path resolution after resolving any
 * existing parent directory through symlinks, ensuring parent-via-symlink
 * escapes are also caught.
 */
export function resolveUnderWorkspace(workspaceRoot: string, candidate: string): string {
  // Resolve the workspace root through any symlinks once so comparisons are
  // against the canonical on-disk path (handles macOS /var → /private/var).
  // If the root itself doesn't exist yet, resolve through the parent chain.
  let rootResolved: string;
  try {
    rootResolved = fs.realpathSync(workspaceRoot);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      const rootAbs = path.resolve(workspaceRoot);
      const rootParent = path.dirname(rootAbs);
      try {
        const rootParentResolved = fs.realpathSync(rootParent);
        rootResolved = path.join(rootParentResolved, path.basename(rootAbs));
      } catch {
        rootResolved = rootAbs;
      }
    } else {
      throw err;
    }
  }

  const absoluteCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(rootResolved, candidate);

  // Resolve symlinks if the path exists. If it doesn't exist yet (a new file
  // we're about to create), resolve any symlinks in the parent chain so that
  // <workspace>/symlink-to-elsewhere/new-file is still caught.
  let candidateResolved: string;
  try {
    candidateResolved = fs.realpathSync(absoluteCandidate);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      const parent = path.dirname(absoluteCandidate);
      try {
        const parentResolved = fs.realpathSync(parent);
        candidateResolved = path.join(parentResolved, path.basename(absoluteCandidate));
      } catch {
        candidateResolved = absoluteCandidate;
      }
    } else {
      throw err;
    }
  }

  if (!isPathInside(rootResolved, candidateResolved)) {
    throw new Error(`outside-workspace: ${candidate} resolves outside ${rootResolved}`);
  }
  return candidateResolved;
}

/**
 * Pure-string check: returns true if candidate is inside (or equal to)
 * workspaceRoot. Both paths should be already-resolved absolute paths.
 * Callers that need symlink safety should call fs.realpathSync before this.
 */
export function isPathInside(workspaceRoot: string, candidate: string): boolean {
  const rootAbs = path.resolve(workspaceRoot);
  const candAbs = path.resolve(candidate);
  return candAbs === rootAbs || candAbs.startsWith(rootAbs + path.sep);
}
