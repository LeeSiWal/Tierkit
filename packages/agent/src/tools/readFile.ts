import crypto from "node:crypto";
import fs from "node:fs/promises";
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
import { resolveUnderCwd } from "./safePath.js";
import { gateSensitivePath } from "./tierkitGates.js";
import { envelopeToString } from "./envelopeUtils.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const DEFAULT_MAX_LINES = 300;
const HARD_MAX_LINES = 1000;
const READ_BYTE_CAP = 8 * 1024 * 1024;   // 8MB defensive read cap (was 256KB; envelope handles lines now)

interface ReadFileArgs {
  path?: string;
  startLine?: number;
  maxLines?: number;
  cursor?: string;
}

interface ReadFileData {
  path: string;
  content: string;
}

function sha256OfFile(absPath: string): Promise<string> {
  return fs.readFile(absPath).then((buf) => "sha256:" + crypto.createHash("sha256").update(buf).digest("hex"));
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a file from the workspace and return its content as a JSON envelope " +
    "(tool-result-envelope.v1). For files over 300 lines, returns the first 300 lines " +
    "plus `next.cursor` to continue. Pass that cursor back to read the next chunk. " +
    "Files larger than the hard cap of 1000 lines per call still return a cursor for " +
    "continuation.",
  parameters: [
    { name: "path",      type: "string",  description: "Workspace-relative file path. Ignored when cursor is provided.", required: false },
    { name: "startLine", type: "number",  description: "1-indexed first line to return. Default 1. Ignored when cursor is provided.", required: false },
    { name: "maxLines",  type: "number",  description: "Max lines to return. Default 300; clamped to 1000.", required: false },
    { name: "cursor",    type: "string",  description: "Opaque cursor from a previous envelope's `next.cursor`. When present, overrides path/startLine/maxLines.", required: false },
  ],
  example: ["<read_file>", "<path>src/main.ts</path>", "</read_file>"].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const input = args as ReadFileArgs;
    let targetPath: string;
    let startLine: number;
    let maxLines: number;
    const warnings: string[] = [];

    // ── Cursor source-of-truth ────────────────────────────────────────────
    if (typeof input.cursor === "string" && input.cursor.length > 0) {
      let cur: ReadFileCursor;
      try {
        cur = decodeCursor<ReadFileCursor>(input.cursor);
      } catch (err) {
        if (err instanceof CursorDecodeError) {
          return envelopeToString(cursorInvalidEnvelope("read_file", err.message));
        }
        throw err;
      }
      if (cur.tool !== "read_file") {
        return envelopeToString(cursorInvalidEnvelope("read_file", `cursor.tool was ${cur.tool}`));
      }
      targetPath = cur.path;
      startLine = cur.nextStartLine;
      maxLines = cur.maxLines;

      // Resolve to abs path, check fileHash
      let absPath: string;
      try { absPath = resolveUnderCwd(ctx.cwd, targetPath); }
      catch (err) { return envelopeToString(makeFailureEnvelope("read_file", "path-escape", (err as Error).message)); }
      try {
        const currentHash = await sha256OfFile(absPath);
        if (currentHash !== cur.fileHash) {
          return envelopeToString(staleCursorEnvelope("read_file", `${targetPath} fileHash changed`));
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        // v0.17: on the cursor branch ENOENT means the file was deleted AFTER
        // the cursor was issued. That's a stale-cursor situation, not a
        // genuine "file never existed" — the caller should re-read from the
        // beginning rather than treat the path as missing.
        if (e.code === "ENOENT") {
          return envelopeToString(staleCursorEnvelope("read_file", `${targetPath} was deleted since cursor was issued`));
        }
        return envelopeToString(makeFailureEnvelope("read_file", "read-error", e.message));
      }
    } else {
      // ── Plain (no cursor) path ────────────────────────────────────────────
      targetPath = String(input.path ?? "").trim();
      if (!targetPath) {
        return envelopeToString(makeFailureEnvelope("read_file", "invalid-args", "missing required parameter `path`"));
      }
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

    // ── Resolve abs path, run gates ──────────────────────────────────────
    let absPath: string;
    try { absPath = resolveUnderCwd(ctx.cwd, targetPath); }
    catch (err) { return envelopeToString(makeFailureEnvelope("read_file", "path-escape", (err as Error).message)); }

    const gate = await gateSensitivePath(ctx.tierkitBaseUrl, targetPath);
    if (gate.blocked) {
      return envelopeToString(makeFailureEnvelope(
        "read_file",
        "sensitive-file-blocked",
        `${targetPath} is on the sensitive-file blocklist (${gate.reason ?? "policy"}). Refusing to read.`,
      ));
    }

    // ── Stat + read ───────────────────────────────────────────────────────
    let stat;
    try { stat = await fs.stat(absPath); }
    catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return envelopeToString(makeFailureEnvelope("read_file", "not-found", `file does not exist: ${targetPath}`));
      }
      return envelopeToString(makeFailureEnvelope("read_file", "read-error", e.message));
    }
    if (!stat.isFile()) {
      return envelopeToString(makeFailureEnvelope("read_file", "not-a-file", `${targetPath} exists but is not a regular file`));
    }

    // Read full file (capped at 8MB defensively). Splitting + slicing line-wise.
    let body: string;
    try {
      const buf = await fs.readFile(absPath, { encoding: "utf8" });
      body = buf.length > READ_BYTE_CAP ? buf.slice(0, READ_BYTE_CAP) : buf;
    } catch (err) {
      return envelopeToString(makeFailureEnvelope("read_file", "read-error", (err as Error).message));
    }

    const allLines = body.split(/\r?\n/);
    const totalLines = allLines.length;
    const endLine = Math.min(startLine + maxLines - 1, totalLines);
    const linesReturned = Math.max(0, endLine - startLine + 1);
    const sliced = allLines.slice(startLine - 1, endLine);
    const content = sliced.join("\n");

    const truncated = endLine < totalLines;
    const fileHash = await sha256OfFile(absPath);

    // ── Build envelope ────────────────────────────────────────────────────
    if (!truncated) {
      return envelopeToString(makeSuccessEnvelope<ReadFileData>(
        "read_file",
        { path: targetPath, content },
        {
          truncated: false,
          range: { startLine, endLine },
          size: { linesReturned, totalLines, remainingLines: 0 },
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      ));
    }

    // truncated:true → next is required
    const nextCursor: ReadFileCursor = {
      tool: "read_file",
      path: targetPath,
      nextStartLine: endLine + 1,
      maxLines,
      fileHash,
      createdAt: new Date().toISOString(),
    };
    const encoded = encodeCursor(nextCursor);

    return envelopeToString(makeSuccessEnvelope<ReadFileData>(
      "read_file",
      { path: targetPath, content },
      {
        truncated: true,
        range: { startLine, endLine },
        size: { linesReturned, totalLines, remainingLines: totalLines - endLine },
        next: {
          cursor: encoded,
          suggestedCall: { tool: "read_file", args: { cursor: encoded } },
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    ));
  },
};
