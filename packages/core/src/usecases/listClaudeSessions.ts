/**
 * Index of Claude Code session jsonl files stored in
 * `~/.claude/projects/<encoded-cwd>/*.jsonl`. The encoder matches Claude's
 * own slug rule: replace every `/` and `.` in the workspace path with `-`.
 *
 * Used by the chat-tab sidebar to list every session belonging to the
 * current workspace, regardless of which Claude tool created it
 * (Tierkit Chat, claude CLI, the VS Code extension).
 */

/**
 * Map a workspace path to the directory name Claude uses under
 * `~/.claude/projects/`. Verified against real on-disk samples — Claude
 * does NOT collapse repeated dashes or trim trailing dashes.
 *
 * Only absolute paths are supported; relative paths produce slugs with no
 * leading dash and will silently find nothing in Claude's on-disk layout.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}
