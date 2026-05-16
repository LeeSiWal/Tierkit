import path from "node:path";

/**
 * Resolve a workspace-relative path to its absolute form, refusing paths that escape the
 * workspace root via `..` or absolute paths. This is the first line of defense — Tierkit
 * core also enforces a sensitive-file blocklist at the daemon endpoint, but a quick
 * client-side check catches obvious escapes before they hit the daemon.
 */
export function resolveUnderCwd(cwd: string, relPath: string): string {
  const cwdAbs = path.resolve(cwd);
  const candidate = path.resolve(cwdAbs, relPath);
  if (!candidate.startsWith(cwdAbs + path.sep) && candidate !== cwdAbs) {
    throw new Error(`path escapes workspace root: ${relPath}`);
  }
  return candidate;
}
