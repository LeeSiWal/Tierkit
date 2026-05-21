import fs from "node:fs/promises";
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
import { resolveUnderCwd } from "./safePath.js";
import { envelopeToString } from "./envelopeUtils.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const DEFAULT_MAX_ENTRIES = 200;
const HARD_MAX_ENTRIES = 1000;

// PRESERVED FROM v0.15: noisy directories Tierkit Agent never wants to list.
// Sensitive-file blocking (.env, *.pem) for read_file still happens via
// gateSensitivePath in readFile; here we just hide noise dirs from listing.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".cache",
  "dist",
  "build",
  ".next",
  "coverage",
  ".tierkit",
]);

interface ListFilesArgs {
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
  cursor?: string;
}

interface ListEntry {
  name: string;
  relPath: string;
  kind: "file" | "dir";
}

interface ListFilesData {
  path: string;
  entries: ListEntry[];
}

/**
 * Walk a directory tree applying the SAME filtering rules the v0.15 implementation
 * used: SKIP_DIRS for noise, dotfile-skip (with `.env*` carve-out for visibility),
 * sorted output. The walker does NOT swallow root-level fs errors — those are
 * surfaced as not-found / not-a-directory / read-error by the caller via stat().
 */
async function collectEntries(rootAbs: string, recursive: boolean): Promise<ListEntry[]> {
  const out: ListEntry[] = [];
  async function inner(currentAbs: string, prefix: string): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(currentAbs, { withFileTypes: true });
    } catch {
      // Inside the recursion an unreadable subdir is tolerable (permission errors etc.).
      // The root-level failure is caught by the caller's stat() check.
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (SKIP_DIRS.has(d.name)) continue;
      // Skip hidden dotfiles/dotdirs by default. Show `.env*` (relevant for code
      // config); reads of .env still go through sensitive-file gates in read_file.
      if (d.name.startsWith(".") && d.name !== "." && d.name !== ".." && !d.name.startsWith(".env")) {
        continue;
      }
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      const kind: "file" | "dir" = d.isDirectory() ? "dir" : "file";
      out.push({ name: d.name, relPath: rel, kind });
      if (recursive && d.isDirectory()) {
        await inner(path.join(currentAbs, d.name), rel);
      }
    }
  }
  await inner(rootAbs, "");
  return out;
}

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and directories in the workspace. Returns a tool-result-envelope.v1 " +
    "envelope. For large directories (over 200 entries) returns the first 200 plus " +
    "`next.cursor` to continue paginating.",
  parameters: [
    { name: "path",       type: "string",  description: "Workspace-relative directory. Default '.'. Ignored when cursor is provided.", required: false },
    { name: "recursive",  type: "boolean", description: "Recurse into subdirectories. Default false.", required: false },
    { name: "maxEntries", type: "number",  description: "Max entries to return. Default 200; clamped to 1000.", required: false },
    { name: "cursor",     type: "string",  description: "Opaque cursor from a previous envelope's `next.cursor`.", required: false },
  ],
  example: ["<list_files>", "<path>src</path>", "<recursive>true</recursive>", "</list_files>"].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const input = args as ListFilesArgs;
    let targetPath: string;
    let recursive: boolean;
    let maxEntries: number;
    let nextIndex: number;
    const warnings: string[] = [];

    if (typeof input.cursor === "string" && input.cursor.length > 0) {
      let cur: ListFilesCursor;
      try { cur = decodeCursor<ListFilesCursor>(input.cursor); }
      catch (err) {
        if (err instanceof CursorDecodeError) {
          return envelopeToString(cursorInvalidEnvelope("list_files", err.message));
        }
        throw err;
      }
      if (cur.tool !== "list_files") {
        return envelopeToString(cursorInvalidEnvelope("list_files", `cursor.tool was ${cur.tool}`));
      }
      targetPath = cur.path;
      recursive = cur.recursive;
      maxEntries = cur.maxEntries;
      nextIndex = cur.nextIndex;
    } else {
      targetPath = String(input.path ?? ".").trim() || ".";
      recursive = Boolean(input.recursive);
      const raw = Number(input.maxEntries ?? DEFAULT_MAX_ENTRIES);
      if (Number.isFinite(raw) && raw > HARD_MAX_ENTRIES) {
        maxEntries = HARD_MAX_ENTRIES;
        warnings.push(`maxEntries clamped to ${HARD_MAX_ENTRIES}`);
      } else if (Number.isFinite(raw) && raw >= 1) {
        maxEntries = Math.floor(raw);
      } else {
        maxEntries = DEFAULT_MAX_ENTRIES;
      }
      nextIndex = 0;
    }

    let rootAbs: string;
    try { rootAbs = resolveUnderCwd(ctx.cwd, targetPath); }
    catch (err) {
      return envelopeToString(makeFailureEnvelope("list_files", "path-escape", (err as Error).message));
    }

    // Stat the root BEFORE walking — preserves v0.15 explicit error codes for
    // missing paths and non-directories. Without this, an ENOENT root would
    // silently surface as "success with 0 entries".
    let stat;
    try { stat = await fs.stat(rootAbs); }
    catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return envelopeToString(makeFailureEnvelope("list_files", "not-found", `directory does not exist: ${targetPath}`));
      }
      return envelopeToString(makeFailureEnvelope("list_files", "read-error", e.message ?? String(e)));
    }
    if (!stat.isDirectory()) {
      return envelopeToString(makeFailureEnvelope("list_files", "not-a-directory", `${targetPath} is not a directory`));
    }

    const allEntries = await collectEntries(rootAbs, recursive);

    const slice = allEntries.slice(nextIndex, nextIndex + maxEntries);
    const truncated = nextIndex + slice.length < allEntries.length;

    if (!truncated) {
      return envelopeToString(makeSuccessEnvelope<ListFilesData>(
        "list_files",
        { path: targetPath, entries: slice },
        {
          truncated: false,
          size: { totalLines: allEntries.length, linesReturned: slice.length, remainingLines: 0 },
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      ));
    }

    const cur: ListFilesCursor = {
      tool: "list_files",
      path: targetPath,
      recursive,
      nextIndex: nextIndex + slice.length,
      maxEntries,
      createdAt: new Date().toISOString(),
    };
    const encoded = encodeCursor(cur);

    return envelopeToString(makeSuccessEnvelope<ListFilesData>(
      "list_files",
      { path: targetPath, entries: slice },
      {
        truncated: true,
        size: { totalLines: allEntries.length, linesReturned: slice.length, remainingLines: allEntries.length - nextIndex - slice.length },
        next: { cursor: encoded, suggestedCall: { tool: "list_files", args: { cursor: encoded } } },
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    ));
  },
};
