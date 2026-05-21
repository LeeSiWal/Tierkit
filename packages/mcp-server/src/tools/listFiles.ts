import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import { loadIgnoreSources, isIgnored } from "../ignoreSources.js";

export interface ListFilesInput {
  workspaceRoot: string;
  path: string;        // relative to workspaceRoot
  recursive?: boolean; // default false
}

export interface ListEntry {
  name: string;
  relPath: string;     // relative to workspaceRoot
  kind: "file" | "directory";
}

export type ListFilesResult =
  | { ok: true; entries: ListEntry[] }
  | { ok: false; code: string; message: string };

export async function listFilesTool(input: ListFilesInput): Promise<ListFilesResult> {
  // Resolve to the workspace root and target path through symlinks.
  // resolveUnderWorkspace already calls fs.realpathSync, so we can extract
  // the resolved root from resolving "." to the canonical workspace base.
  let resolvedRoot: string;
  try {
    resolvedRoot = resolveUnderWorkspace(input.workspaceRoot, ".");
  } catch (err) {
    return { ok: false, code: "outside-workspace", message: String((err as Error).message) };
  }

  let absPath: string;
  try {
    absPath = resolveUnderWorkspace(input.workspaceRoot, input.path);
  } catch (err) {
    return { ok: false, code: "outside-workspace", message: String((err as Error).message) };
  }

  const sources = await loadIgnoreSources(input.workspaceRoot);
  const entries: ListEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const childAbs = path.join(dir, item.name);
      const relToWs = path.relative(resolvedRoot, childAbs);
      if (isIgnored(sources, relToWs)) continue;
      entries.push({
        name: item.name,
        relPath: relToWs.split(path.sep).join("/"),
        kind: item.isDirectory() ? "directory" : "file",
      });
      if (input.recursive && item.isDirectory()) {
        await walk(childAbs);
      }
    }
  }

  try {
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      return { ok: false, code: "not-a-directory", message: `${input.path} is not a directory` };
    }
    await walk(absPath);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { ok: false, code: "not-found", message: `${input.path} does not exist` };
    }
    throw err;
  }

  return { ok: true, entries };
}
