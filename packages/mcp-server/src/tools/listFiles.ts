import path from "node:path";
import {
  encodeCursor,
  decodeCursor,
  makeSuccessEnvelope,
  makeFailureEnvelope,
  cursorInvalidEnvelope,
  CursorDecodeError,
  type ListFilesCursor,
} from "@tierkit/core";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import { loadIgnoreSources, isIgnored } from "../ignoreSources.js";
import fs from "node:fs/promises";

const TOOL_NAME = "tierkit.list_files";
const DEFAULT_MAX_ENTRIES = 200;
const HARD_MAX_ENTRIES = 1000;

interface ListFilesInput {
  workspaceRoot: string;
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
  cursor?: string;
}

interface ListEntry { name: string; relPath: string; kind: "file" | "dir"; }
interface ListFilesData { path: string; entries: ListEntry[]; }

async function walk(rootAbs: string, workspaceRootAbs: string, sources: any, recursive: boolean): Promise<ListEntry[]> {
  const out: ListEntry[] = [];
  async function inner(dirAbs: string) {
    let dirents;
    try { dirents = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      const childAbs = path.join(dirAbs, d.name);
      const rel = path.relative(workspaceRootAbs, childAbs).split(path.sep).join("/");
      if (isIgnored(sources, rel)) continue;
      const kind: "file" | "dir" = d.isDirectory() ? "dir" : "file";
      out.push({ name: d.name, relPath: rel, kind });
      if (recursive && d.isDirectory()) await inner(childAbs);
    }
  }
  await inner(rootAbs);
  return out;
}

export async function listFilesTool(input: ListFilesInput) {
  let targetPath: string;
  let recursive: boolean;
  let maxEntries: number;
  let nextIndex: number;
  const warnings: string[] = [];

  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    let cur: ListFilesCursor;
    try { cur = decodeCursor<ListFilesCursor>(input.cursor); }
    catch (err) {
      if (err instanceof CursorDecodeError) return cursorInvalidEnvelope(TOOL_NAME, err.message);
      throw err;
    }
    if (cur.tool !== "list_files") return cursorInvalidEnvelope(TOOL_NAME, `cursor.tool was ${cur.tool}`);
    targetPath = cur.path; recursive = cur.recursive; maxEntries = cur.maxEntries; nextIndex = cur.nextIndex;
  } else {
    targetPath = String(input.path ?? ".").trim() || ".";
    recursive = Boolean(input.recursive);
    const raw = Number(input.maxEntries ?? DEFAULT_MAX_ENTRIES);
    if (Number.isFinite(raw) && raw > HARD_MAX_ENTRIES) { maxEntries = HARD_MAX_ENTRIES; warnings.push(`maxEntries clamped to ${HARD_MAX_ENTRIES}`); }
    else if (Number.isFinite(raw) && raw >= 1) maxEntries = Math.floor(raw);
    else maxEntries = DEFAULT_MAX_ENTRIES;
    nextIndex = 0;
  }

  let rootAbs: string;
  try { rootAbs = resolveUnderWorkspace(input.workspaceRoot, targetPath); }
  catch (err) { return makeFailureEnvelope(TOOL_NAME, "outside-workspace", (err as Error).message); }

  const resolvedWorkspaceRoot = resolveUnderWorkspace(input.workspaceRoot, ".");
  const sources = await loadIgnoreSources(input.workspaceRoot);
  const all = await walk(rootAbs, resolvedWorkspaceRoot, sources, recursive);
  const slice = all.slice(nextIndex, nextIndex + maxEntries);
  const truncated = nextIndex + slice.length < all.length;

  if (!truncated) {
    return makeSuccessEnvelope<ListFilesData>(TOOL_NAME, { path: targetPath, entries: slice }, {
      truncated: false,
      size: { totalLines: all.length, linesReturned: slice.length, remainingLines: 0 },
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  const cur: ListFilesCursor = {
    tool: "list_files", path: targetPath, recursive,
    nextIndex: nextIndex + slice.length, maxEntries,
    createdAt: new Date().toISOString(),
  };
  const encoded = encodeCursor(cur);
  return makeSuccessEnvelope<ListFilesData>(TOOL_NAME, { path: targetPath, entries: slice }, {
    truncated: true,
    size: { totalLines: all.length, linesReturned: slice.length, remainingLines: all.length - nextIndex - slice.length },
    next: { cursor: encoded, suggestedCall: { tool: "tierkit.list_files", args: { cursor: encoded } } },
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}
