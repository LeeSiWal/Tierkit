import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import { isDenied } from "../pathDenylist.js";
import { redactOutput, type RedactHit } from "../redactOutput.js";

export interface ReadFileInput {
  workspaceRoot: string;
  path: string;
  maxBytes?: number;  // default 1 MiB
}

export type ReadFileResult =
  | {
      ok: true;
      content: string;
      redacted: boolean;
      redactionHits: RedactHit[];
      bytesRead: number;
      truncated: boolean;
    }
  | { ok: false; code: string; message: string };

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

export async function readFileTool(input: ReadFileInput): Promise<ReadFileResult> {
  let absPath: string;
  try {
    absPath = resolveUnderWorkspace(input.workspaceRoot, input.path);
  } catch (err) {
    return { ok: false, code: "outside-workspace", message: String((err as Error).message) };
  }

  const relToWs = path.relative(input.workspaceRoot, absPath).split(path.sep).join("/");
  if (isDenied(relToWs)) {
    return { ok: false, code: "ignored-path", message: `${input.path} is in the path denylist` };
  }

  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  let buf: Buffer;
  let truncated: boolean;
  let bytesRead: number;

  try {
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) {
      return { ok: false, code: "not-a-file", message: `${input.path} is a directory` };
    }
    const readBytes = Math.min(stat.size, maxBytes);
    const fh = await fs.open(absPath, "r");
    try {
      buf = Buffer.alloc(readBytes);
      await fh.read(buf, 0, readBytes, 0);
    } finally {
      await fh.close();
    }
    truncated = stat.size > maxBytes;
    bytesRead = readBytes;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { ok: false, code: "not-found", message: `${input.path} does not exist` };
    }
    throw err;
  }

  const raw = buf.toString("utf8");
  const redacted = redactOutput(raw);
  return {
    ok: true,
    content: redacted.text,
    redacted: redacted.hits.length > 0,
    redactionHits: redacted.hits,
    bytesRead,
    truncated,
  };
}
