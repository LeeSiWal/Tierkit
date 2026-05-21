import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type PatchStatus = "proposed" | "awaiting_approval" | "applied" | "rejected" | "expired";
export type ApprovalState = "pending" | "approved" | "rejected";
export type ApprovedBy = "cli" | "gui";

export interface PatchFileEntry {
  path: string;
  beforeExists: boolean;
  beforeHash: string | null;
  afterHash: string;
}

export interface PatchApproval {
  state: ApprovalState;
  decidedAt: string | null;
  decidedBy: ApprovedBy | null;
  note: string | null;
}

export interface PatchTicket {
  patchId: string;
  createdAt: string;
  workspaceRoot: string;
  source: "mcp" | "cli" | "gui";
  proposedBy: string;
  files: PatchFileEntry[];
  diff: string;
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  requiresApproval: boolean;
  status: PatchStatus;
  approval: PatchApproval;
}

export class InvalidPatchStateError extends Error {
  code = "invalid-status";
  constructor(message: string) {
    super(message);
    this.name = "InvalidPatchStateError";
  }
}

const PATCH_DIR = ".tierkit/runtime/mcp/patches";
const APPLIED_TTL_MS = 7 * 24 * 3600 * 1000;
const REJECTED_TTL_MS = 7 * 24 * 3600 * 1000;
const EXPIRED_TTL_MS = 24 * 3600 * 1000;

function patchJsonPath(workspaceRoot: string, patchId: string): string {
  return path.join(workspaceRoot, PATCH_DIR, `${patchId}.json`);
}

function payloadDirPath(workspaceRoot: string, patchId: string): string {
  return path.join(workspaceRoot, PATCH_DIR, `${patchId}.payload`);
}

async function ensureDir(workspaceRoot: string): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, PATCH_DIR), { recursive: true });
}

function newPatchId(): string {
  return `patch_${crypto.randomBytes(4).toString("hex")}${crypto.randomBytes(4).toString("hex")}`;
}

export type CreatePatchInput = Omit<PatchTicket, "patchId" | "createdAt" | "status" | "approval">;

export async function createPatchTicket(workspaceRoot: string, input: CreatePatchInput): Promise<PatchTicket> {
  await ensureDir(workspaceRoot);
  const ticket: PatchTicket = {
    ...input,
    patchId: newPatchId(),
    createdAt: new Date().toISOString(),
    status: "proposed",
    approval: { state: "pending", decidedAt: null, decidedBy: null, note: null },
  };
  const file = patchJsonPath(workspaceRoot, ticket.patchId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(ticket, null, 2));
  await fs.rename(tmp, file);
  return ticket;
}

export async function readPatchTicket(workspaceRoot: string, patchId: string): Promise<PatchTicket> {
  const raw = await fs.readFile(patchJsonPath(workspaceRoot, patchId), "utf8");
  return JSON.parse(raw) as PatchTicket;
}

export async function listPatchTickets(workspaceRoot: string): Promise<PatchTicket[]> {
  await ensureDir(workspaceRoot);
  const dir = path.join(workspaceRoot, PATCH_DIR);
  const names = await fs.readdir(dir);
  const out: PatchTicket[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, n), "utf8");
      out.push(JSON.parse(raw) as PatchTicket);
    } catch { /* skip malformed */ }
  }
  return out;
}

export async function updatePatchTicket(
  workspaceRoot: string,
  patchId: string,
  patch: Partial<PatchTicket>,
): Promise<PatchTicket> {
  const current = await readPatchTicket(workspaceRoot, patchId);
  const next: PatchTicket = { ...current, ...patch, patchId: current.patchId };
  const file = patchJsonPath(workspaceRoot, patchId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, file);
  return next;
}

/**
 * Approve a ticket. Only valid when status ∈ {proposed, awaiting_approval}.
 * CLI and HTTP endpoints MUST call this rather than calling updatePatchTicket()
 * directly, so the state machine is enforced in exactly one place.
 */
export async function approvePatchTicket(
  workspaceRoot: string,
  patchId: string,
  decidedBy: ApprovedBy,
  note: string | null,
): Promise<PatchTicket> {
  const current = await readPatchTicket(workspaceRoot, patchId);
  if (current.status !== "proposed" && current.status !== "awaiting_approval") {
    throw new InvalidPatchStateError(
      `invalid-status: cannot approve patch ${patchId} in status=${current.status}`,
    );
  }
  return updatePatchTicket(workspaceRoot, patchId, {
    approval: {
      state: "approved",
      decidedAt: new Date().toISOString(),
      decidedBy,
      note,
    },
  });
}

/** Reject a ticket. Same state-gate as approve. */
export async function rejectPatchTicket(
  workspaceRoot: string,
  patchId: string,
  decidedBy: ApprovedBy,
  note: string | null,
): Promise<PatchTicket> {
  const current = await readPatchTicket(workspaceRoot, patchId);
  if (current.status !== "proposed" && current.status !== "awaiting_approval") {
    throw new InvalidPatchStateError(
      `invalid-status: cannot reject patch ${patchId} in status=${current.status}`,
    );
  }
  return updatePatchTicket(workspaceRoot, patchId, {
    status: "rejected",
    approval: {
      state: "rejected",
      decidedAt: new Date().toISOString(),
      decidedBy,
      note,
    },
  });
}

export async function deletePatchTicket(workspaceRoot: string, patchId: string): Promise<void> {
  // Delete both the ticket JSON and its payload sidecar. Either may be missing.
  await fs.unlink(patchJsonPath(workspaceRoot, patchId)).catch(() => {});
  await fs.rm(payloadDirPath(workspaceRoot, patchId), { recursive: true, force: true });
}

// ---- payload sidecar ----
//
// Proposed file content is stored next to the ticket JSON as
// .tierkit/runtime/mcp/patches/<patchId>.payload/f<i>.txt
// applyPatchTool verifies the payload's sha256 matches the ticket's afterHash
// before writing — protects against the sidecar being tampered with between
// propose and apply.

export interface PayloadEntry { index: number; content: string; }

export async function writePatchPayload(
  workspaceRoot: string,
  patchId: string,
  entries: PayloadEntry[],
): Promise<void> {
  const dir = payloadDirPath(workspaceRoot, patchId);
  await fs.mkdir(dir, { recursive: true });
  for (const e of entries) {
    await fs.writeFile(path.join(dir, `f${e.index}.txt`), e.content);
  }
}

export async function readPatchPayload(
  workspaceRoot: string,
  patchId: string,
  index: number,
): Promise<string> {
  return fs.readFile(path.join(payloadDirPath(workspaceRoot, patchId), `f${index}.txt`), "utf8");
}

export async function cleanupExpiredAndApplied(workspaceRoot: string, now: Date): Promise<string[]> {
  const removed: string[] = [];
  const all = await listPatchTickets(workspaceRoot);
  for (const t of all) {
    const ageMs = now.getTime() - new Date(t.createdAt).getTime();
    const shouldRemove =
      (t.status === "applied" && ageMs > APPLIED_TTL_MS) ||
      (t.status === "rejected" && ageMs > REJECTED_TTL_MS) ||
      (t.status === "expired" && ageMs > EXPIRED_TTL_MS);
    if (shouldRemove) {
      await deletePatchTicket(workspaceRoot, t.patchId); // also removes payload dir
      removed.push(t.patchId);
    }
  }
  return removed;
}
