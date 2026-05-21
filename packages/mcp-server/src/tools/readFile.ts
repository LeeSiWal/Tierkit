import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  encodeCursor,
  decodeCursor,
  makeSuccessEnvelope,
  makeFailureEnvelope,
  cursorInvalidEnvelope,
  staleCursorEnvelope,
  CursorDecodeError,
  type ReadFileCursor,
} from "@tierkit/core";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import { isDenied } from "../pathDenylist.js";
import { loadIgnoreSources, isIgnored } from "../ignoreSources.js";
import { redactOutput } from "../redactOutput.js";

const TOOL_NAME = "tierkit.read_file";
const DEFAULT_MAX_LINES = 300;
const HARD_MAX_LINES = 1000;
const READ_BYTE_CAP = 8 * 1024 * 1024;

interface ReadFileInput {
  workspaceRoot: string;
  path?: string;
  startLine?: number;
  maxLines?: number;
  cursor?: string;
}

interface ReadFileData {
  path: string;
  content: string;
}

async function sha256OfFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

export async function readFileTool(input: ReadFileInput) {
  let targetPath: string;
  let startLine: number;
  let maxLines: number;
  const warnings: string[] = [];

  // Resolve workspace root once (symlink-aware via existing helper)
  const resolvedRoot = resolveUnderWorkspace(input.workspaceRoot, ".");

  // ── Cursor source-of-truth ────────────────────────────────────────────
  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    let cur: ReadFileCursor;
    try { cur = decodeCursor<ReadFileCursor>(input.cursor); }
    catch (err) {
      if (err instanceof CursorDecodeError) return cursorInvalidEnvelope(TOOL_NAME, err.message);
      throw err;
    }
    if (cur.tool !== "read_file") return cursorInvalidEnvelope(TOOL_NAME, `cursor.tool was ${cur.tool}`);
    targetPath = cur.path;
    startLine = cur.nextStartLine;
    maxLines = cur.maxLines;

    let absPath: string;
    try { absPath = resolveUnderWorkspace(input.workspaceRoot, targetPath); }
    catch (err) { return makeFailureEnvelope(TOOL_NAME, "outside-workspace", (err as Error).message); }
    try {
      const currentHash = await sha256OfFile(absPath);
      if (currentHash !== cur.fileHash) {
        return staleCursorEnvelope(TOOL_NAME, `${targetPath} fileHash changed`);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return makeFailureEnvelope(TOOL_NAME, "not-found", `${targetPath} does not exist`);
      return makeFailureEnvelope(TOOL_NAME, "read-error", e.message);
    }
  } else {
    targetPath = String(input.path ?? "").trim();
    if (!targetPath) return makeFailureEnvelope(TOOL_NAME, "invalid-args", "missing required parameter `path`");
    const startLineRaw = Number(input.startLine ?? 1);
    startLine = Number.isInteger(startLineRaw) && startLineRaw >= 1 ? startLineRaw : 1;
    const maxLinesRaw = Number(input.maxLines ?? DEFAULT_MAX_LINES);
    if (Number.isFinite(maxLinesRaw) && maxLinesRaw > HARD_MAX_LINES) {
      maxLines = HARD_MAX_LINES;
      warnings.push(`maxLines clamped to ${HARD_MAX_LINES}`);
    } else if (Number.isFinite(maxLinesRaw) && maxLinesRaw >= 1) {
      maxLines = Math.floor(maxLinesRaw);
    } else {
      maxLines = DEFAULT_MAX_LINES;
    }
  }

  // ── Boundary + gates ──────────────────────────────────────────────────
  let absPath: string;
  try { absPath = resolveUnderWorkspace(input.workspaceRoot, targetPath); }
  catch (err) { return makeFailureEnvelope(TOOL_NAME, "outside-workspace", (err as Error).message); }

  const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join("/");
  if (isDenied(relPath)) {
    return makeFailureEnvelope(TOOL_NAME, "ignored-path", `${targetPath} is on the path denylist`);
  }
  const sources = await loadIgnoreSources(input.workspaceRoot);
  if (isIgnored(sources, relPath)) {
    return makeFailureEnvelope(TOOL_NAME, "ignored-path", `${targetPath} is in the ignore list`);
  }

  // ── Stat + read ───────────────────────────────────────────────────────
  let stat;
  try { stat = await fs.stat(absPath); }
  catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return makeFailureEnvelope(TOOL_NAME, "not-found", `${targetPath} does not exist`);
    return makeFailureEnvelope(TOOL_NAME, "read-error", e.message);
  }
  if (!stat.isFile()) return makeFailureEnvelope(TOOL_NAME, "not-a-file", `${targetPath} is not a regular file`);

  let body: string;
  try {
    const raw = await fs.readFile(absPath, "utf8");
    body = raw.length > READ_BYTE_CAP ? raw.slice(0, READ_BYTE_CAP) : raw;
  } catch (err) {
    return makeFailureEnvelope(TOOL_NAME, "read-error", (err as Error).message);
  }

  const allLines = body.split(/\r?\n/);
  const totalLines = allLines.length;
  const endLine = Math.min(startLine + maxLines - 1, totalLines);
  const linesReturned = Math.max(0, endLine - startLine + 1);
  const sliced = allLines.slice(startLine - 1, endLine).join("\n");

  // Redact secrets in the returned slice
  const red = redactOutput(sliced);
  const content = red.text;

  const truncated = endLine < totalLines;
  const fileHash = await sha256OfFile(absPath);

  if (!truncated) {
    return makeSuccessEnvelope<ReadFileData>(TOOL_NAME, { path: targetPath, content }, {
      truncated: false,
      range: { startLine, endLine },
      size: { linesReturned, totalLines, remainingLines: 0 },
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  const nextCursor: ReadFileCursor = {
    tool: "read_file",
    path: targetPath,
    nextStartLine: endLine + 1,
    maxLines,
    fileHash,
    createdAt: new Date().toISOString(),
  };
  const encoded = encodeCursor(nextCursor);

  return makeSuccessEnvelope<ReadFileData>(TOOL_NAME, { path: targetPath, content }, {
    truncated: true,
    range: { startLine, endLine },
    size: { linesReturned, totalLines, remainingLines: totalLines - endLine },
    next: { cursor: encoded, suggestedCall: { tool: "tierkit.read_file", args: { cursor: encoded } } },
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}
