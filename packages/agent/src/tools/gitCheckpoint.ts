import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Create a lightweight git stash-like checkpoint so a destructive tool's effect can be undone
 * with a single command. We can't safely auto-revert (the user might intermix manual edits),
 * but we leave a `refs/tierkit-checkpoints/<id>` ref pointing at a commit that captures the
 * working tree state BEFORE the tool ran.
 *
 * Strategy:
 *   1. If not a git repo → silently skip (no checkpoint, no error).
 *   2. Write the working tree to a temporary commit via `git stash create` (does not modify
 *      the index or working tree, and works even with no staged changes).
 *   3. Update `refs/tierkit-checkpoints/<id>` to that commit hash.
 *
 * Returns the ref name on success, or `null` on any failure. Never throws.
 *
 * Recovery (manual): `git checkout refs/tierkit-checkpoints/<id> -- <path>` restores a file.
 */
export async function createGitCheckpoint(cwd: string, label: string): Promise<string | null> {
  const gitDir = path.join(cwd, ".git");
  try {
    const stat = await fs.stat(gitDir);
    if (!stat.isDirectory() && !stat.isFile()) return null; // submodule .git is a file — both fine
  } catch {
    return null;
  }

  const id = `${Date.now().toString(36)}-${label.replace(/[^a-z0-9-]/gi, "-").slice(0, 40)}`;
  const refName = `refs/tierkit-checkpoints/${id}`;

  const commitSha = await runGit(cwd, ["stash", "create"]);
  if (!commitSha) return null;

  const ok = await runGit(cwd, ["update-ref", refName, commitSha]);
  if (ok === null) return null;
  return refName;
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(out).toString("utf8").trim());
    });
  });
}
