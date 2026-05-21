import fs from "node:fs/promises";
import path from "node:path";
import ignoreLib from "ignore";

const BUNDLED_DENYLIST = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.*",
  "id_dsa",
  "id_dsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "secrets.json",
  ".tierkit",
  ".tierkit/",
];

export interface IgnoreSources {
  ig: ReturnType<typeof ignoreLib>;
}

async function tryRead(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (err: any) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Load ignore patterns from all sources, applying precedence:
 *   bundled denylist (always)
 *   > .tierkit/ignore
 *   > .tierkit-ignore (legacy fallback, union merge)
 *   > .gitignore (unless workspace config sets respectGitignore=false; for v0.15 always honored)
 *
 * Returns a matcher. Patterns from later sources are unioned, not overridden —
 * once any source says a path is ignored, it stays ignored. (The "precedence"
 * matters mainly for documenting which file to edit if you want to remove an
 * ignore: bundled is hard-coded; the others are workspace files.)
 */
export async function loadIgnoreSources(workspaceRoot: string): Promise<IgnoreSources> {
  const ig = ignoreLib();
  ig.add(BUNDLED_DENYLIST);

  const tierkitIgnore = await tryRead(path.join(workspaceRoot, ".tierkit", "ignore"));
  if (tierkitIgnore) ig.add(tierkitIgnore);

  const legacyIgnore = await tryRead(path.join(workspaceRoot, ".tierkit-ignore"));
  if (legacyIgnore) ig.add(legacyIgnore);

  const gitignore = await tryRead(path.join(workspaceRoot, ".gitignore"));
  if (gitignore) ig.add(gitignore);

  return { ig };
}

export function isIgnored(sources: IgnoreSources, relPath: string): boolean {
  // `ignore` requires forward slashes and no leading slash
  const normalized = relPath.replace(/^\/+/, "").split(path.sep).join("/");
  return sources.ig.ignores(normalized);
}
