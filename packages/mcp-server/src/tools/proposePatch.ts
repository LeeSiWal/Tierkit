import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import { isDenied } from "../pathDenylist.js";
import { loadIgnoreSources, isIgnored } from "../ignoreSources.js";
import { scorePatchRisk } from "../risk.js";
import { createPatchTicket, writePatchPayload, type PatchFileEntry } from "@tierkit/core";

export interface ProposedFile {
  path: string;
  newContent?: string;
  deleted?: boolean; // explicitly refused; flagged here for clarity
}

export interface ProposePatchInput {
  workspaceRoot: string;
  files: ProposedFile[];
  note?: string;
  proposedBy?: string;
}

export type ProposePatchResult =
  | { ok: true; patchId: string; diff: string; files: PatchFileEntry[]; risk: { level: string; reasons: string[] }; requiresApproval: boolean }
  | { ok: false; code: string; message: string };

function sha256(content: string | Buffer): string {
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

function makeUnifiedDiff(filePath: string, before: string | null, after: string): string {
  // Minimal unified diff for human display. Not used to apply the change
  // (apply step writes newContent directly). v0.15.1 may swap in a real
  // unified-diff library if user feedback wants standard diff output.
  const beforeLines = before == null ? [] : before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  const body = `@@ ${beforeLines.length} → ${afterLines.length} lines @@\n`
    + beforeLines.map((l) => `-${l}`).join("\n")
    + (beforeLines.length > 0 ? "\n" : "")
    + afterLines.map((l) => `+${l}`).join("\n");
  return header + body + "\n";
}

const APPROVAL_THRESHOLD = new Set(["medium", "high"]);

export async function proposePatchTool(input: ProposePatchInput): Promise<ProposePatchResult> {
  if (!input.files || input.files.length === 0) {
    return { ok: false, code: "invalid-input", message: "files is empty" };
  }
  for (const f of input.files) {
    if (f.deleted) {
      return { ok: false, code: "delete-not-supported", message: "File deletion is not supported in v0.15." };
    }
    if (typeof f.newContent !== "string") {
      return { ok: false, code: "invalid-input", message: `file ${f.path}: newContent must be a string` };
    }
  }

  // Resolve the workspace root through symlinks (handles macOS /tmp → /private/tmp)
  // so that path.relative() produces clean relative paths.
  let resolvedRoot: string;
  try {
    resolvedRoot = resolveUnderWorkspace(input.workspaceRoot, ".");
  } catch (err) {
    return { ok: false, code: "outside-workspace", message: String((err as Error).message) };
  }

  const sources = await loadIgnoreSources(input.workspaceRoot);
  const entries: PatchFileEntry[] = [];
  const diffs: string[] = [];

  for (const f of input.files) {
    let absPath: string;
    try {
      absPath = resolveUnderWorkspace(input.workspaceRoot, f.path);
    } catch (err) {
      return { ok: false, code: "outside-workspace", message: String((err as Error).message) };
    }
    const relToWs = path.relative(resolvedRoot, absPath).split(path.sep).join("/");
    if (isDenied(relToWs) || isIgnored(sources, relToWs)) {
      return { ok: false, code: "ignored-path", message: `${f.path} is in the ignore/denylist` };
    }

    let beforeExists = false;
    let beforeHash: string | null = null;
    let beforeContent: string | null = null;
    try {
      beforeContent = await fs.readFile(absPath, "utf8");
      beforeExists = true;
      beforeHash = sha256(beforeContent);
    } catch (err: any) {
      if (!err || err.code !== "ENOENT") throw err;
    }

    const afterContent = f.newContent ?? "";
    const afterHash = sha256(afterContent);
    entries.push({ path: relToWs, beforeExists, beforeHash, afterHash });
    diffs.push(makeUnifiedDiff(relToWs, beforeContent, afterContent));
  }

  const risk = scorePatchRisk({ files: entries });
  const requiresApproval = APPROVAL_THRESHOLD.has(risk.level);

  const ticket = await createPatchTicket(input.workspaceRoot, {
    workspaceRoot: input.workspaceRoot,
    source: "mcp",
    proposedBy: input.proposedBy ?? "claude-code",
    files: entries,
    diff: diffs.join("\n"),
    risk,
    requiresApproval,
  });

  // Persist the newContent payload alongside the ticket so apply_patch can write
  // without taking new args. The store owns the sidecar layout — we just hand it
  // entries indexed to match `ticket.files`. apply_patch will sha256-verify each
  // payload against the ticket's afterHash before writing.
  await writePatchPayload(
    input.workspaceRoot,
    ticket.patchId,
    input.files.map((f, i) => ({ index: i, content: f.newContent ?? "" })),
  );

  return {
    ok: true,
    patchId: ticket.patchId,
    diff: ticket.diff,
    files: ticket.files,
    risk: ticket.risk,
    requiresApproval: ticket.requiresApproval,
  };
}
