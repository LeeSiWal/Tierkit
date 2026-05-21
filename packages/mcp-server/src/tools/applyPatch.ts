import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import {
  readPatchTicket,
  updatePatchTicket,
  readPatchPayload,
  type PatchTicket,
} from "@tierkit/core";

export interface ApplyPatchInput {
  workspaceRoot: string;
  patchId: string;
}

export type ApplyPatchResult =
  | { ok: true; applied: true; files: string[]; durationMs: number }
  | { ok: false; code: string; message: string; approval?: { guiPath: string; cliCommand: string } };

const EXPIRY_MS = 24 * 3600 * 1000;

function sha256(content: string | Buffer): string {
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

function approvalEnvelope(workspaceRoot: string, patchId: string): { guiPath: string; cliCommand: string } {
  return {
    guiPath: `/v1/mcp/patches/${patchId}`,
    cliCommand: `tierkit mcp patch approve ${patchId} --workspace ${workspaceRoot}`,
  };
}

export async function applyPatchTool(input: ApplyPatchInput): Promise<ApplyPatchResult> {
  const startedAt = Date.now();
  let ticket: PatchTicket;
  try {
    ticket = await readPatchTicket(input.workspaceRoot, input.patchId);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { ok: false, code: "not-found", message: `patch ${input.patchId} does not exist` };
    }
    throw err;
  }

  // ---- status guards (terminal states) ----
  if (ticket.status === "applied") {
    return { ok: false, code: "invalid-status", message: "patch was already applied" };
  }
  if (ticket.status === "rejected") {
    return { ok: false, code: "approval-rejected", message: "patch was rejected" };
  }
  if (ticket.status === "expired") {
    return { ok: false, code: "expired-patch", message: "patch is expired" };
  }

  // ---- expiry check (24h) ----
  const ageMs = Date.now() - new Date(ticket.createdAt).getTime();
  if (ageMs > EXPIRY_MS) {
    await updatePatchTicket(input.workspaceRoot, ticket.patchId, { status: "expired" });
    return { ok: false, code: "expired-patch", message: "patch ticket is older than 24h" };
  }

  // ---- freshness check — must hold regardless of approval state ----
  // Checking BEFORE the approval gate ensures an approved-but-stale patch is rejected.
  for (const f of ticket.files) {
    let absPath: string;
    try {
      absPath = resolveUnderWorkspace(input.workspaceRoot, f.path);
    } catch (err) {
      return { ok: false, code: "outside-workspace", message: String((err as Error).message) };
    }
    if (f.beforeExists) {
      let current: string;
      try { current = await fs.readFile(absPath, "utf8"); }
      catch (err: any) {
        return { ok: false, code: "stale-patch", message: `${f.path} no longer exists (was expected to)` };
      }
      if (sha256(current) !== f.beforeHash) {
        return { ok: false, code: "stale-patch", message: `${f.path} was modified after the patch was proposed` };
      }
    } else {
      // New file: file must NOT exist yet
      try {
        await fs.stat(absPath);
        return { ok: false, code: "stale-patch", message: `${f.path} now exists (was expected to be new)` };
      } catch (err: any) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }
  }

  // ---- approval gate ----
  if (ticket.requiresApproval) {
    if (ticket.status === "proposed") {
      // First call — transition to awaiting_approval and tell caller to approve
      await updatePatchTicket(input.workspaceRoot, ticket.patchId, { status: "awaiting_approval" });
      return {
        ok: false,
        code: "approval-required",
        message: "Patch requires approval. Approve via Tierkit GUI or run the CLI command shown.",
        approval: approvalEnvelope(input.workspaceRoot, ticket.patchId),
      };
    }
    // status === "awaiting_approval" — re-read for latest approval decision
    const latest = await readPatchTicket(input.workspaceRoot, ticket.patchId);
    if (latest.approval.state === "pending") {
      return {
        ok: false,
        code: "approval-required",
        message: "Patch is awaiting approval. Approve via Tierkit GUI or CLI.",
        approval: approvalEnvelope(input.workspaceRoot, ticket.patchId),
      };
    }
    if (latest.approval.state === "rejected") {
      // Reconcile defensively: approval.state rejected but status not yet moved
      if (latest.status !== "rejected") {
        await updatePatchTicket(input.workspaceRoot, ticket.patchId, { status: "rejected" });
      }
      return { ok: false, code: "approval-rejected", message: "patch was rejected" };
    }
    // approved → fall through to write
  }

  // ---- payload integrity: sha256-verify each sidecar before writing ----
  // This is the critical security guarantee (Non-negotiable #6).
  // Protects against the sidecar being tampered with between propose and apply.
  const payloads: string[] = [];
  for (const [i, f] of ticket.files.entries()) {
    let payload: string;
    try {
      payload = await readPatchPayload(input.workspaceRoot, ticket.patchId, i);
    } catch (err: any) {
      return {
        ok: false,
        code: "payload-missing",
        message: `payload for ${f.path} (index ${i}) is missing from sidecar`,
      };
    }
    if (sha256(payload) !== f.afterHash) {
      return {
        ok: false,
        code: "payload-corrupt",
        message: `payload for ${f.path} does not match afterHash recorded at propose time`,
      };
    }
    payloads.push(payload);
  }

  // ---- write (atomic per file via temp + rename) ----
  const written: string[] = [];
  for (const [i, f] of ticket.files.entries()) {
    const payload = payloads[i] ?? "";
    const absPath = resolveUnderWorkspace(input.workspaceRoot, f.path);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, payload);
    await fs.rename(tmp, absPath);
    written.push(f.path);
  }
  await updatePatchTicket(input.workspaceRoot, ticket.patchId, { status: "applied" });

  return { ok: true, applied: true, files: written, durationMs: Date.now() - startedAt };
}
