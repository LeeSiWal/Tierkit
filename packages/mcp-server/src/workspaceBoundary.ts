import path from "node:path";

/**
 * Resolve a workspace-relative or absolute path. Returns the absolute path
 * if it lies inside workspaceRoot (or equals it). Throws Error with message
 * containing "outside-workspace" otherwise. Callers should catch and convert
 * to an MCP error envelope.
 */
export function resolveUnderWorkspace(workspaceRoot: string, candidate: string): string {
  const rootAbs = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(rootAbs, candidate);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    throw new Error(`outside-workspace: ${candidate} resolves outside ${rootAbs}`);
  }
  return resolved;
}

export function isPathInside(workspaceRoot: string, candidate: string): boolean {
  const rootAbs = path.resolve(workspaceRoot);
  const candAbs = path.resolve(candidate);
  return candAbs === rootAbs || candAbs.startsWith(rootAbs + path.sep);
}
