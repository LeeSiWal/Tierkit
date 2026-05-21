import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPatchTicket,
  readPatchTicket,
  listPatchTickets,
  updatePatchTicket,
  approvePatchTicket,
  rejectPatchTicket,
  writePatchPayload,
  readPatchPayload,
  cleanupExpiredAndApplied,
  InvalidPatchStateError,
  type PatchTicket,
} from "../src/mcp/patchStore.js";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-patchstore-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

const sampleTicket = (): Omit<PatchTicket, "patchId" | "createdAt" | "status" | "approval"> => ({
  workspaceRoot: "/tmp/sample",
  source: "mcp",
  proposedBy: "claude-code",
  files: [{ path: "src/foo.ts", beforeExists: true, beforeHash: "sha256:aaa", afterHash: "sha256:bbb" }],
  diff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ ...",
  risk: { level: "medium", reasons: ["modifies source file"] },
  requiresApproval: true,
});

describe("patchStore", () => {
  it("creates a ticket with sequential id-like uniqueness", async () => {
    const a = await createPatchTicket(workspace, sampleTicket());
    const b = await createPatchTicket(workspace, sampleTicket());
    expect(a.patchId).not.toBe(b.patchId);
    expect(a.status).toBe("proposed");
    expect(a.approval.state).toBe("pending");
  });

  it("reads back what it wrote", async () => {
    const t = await createPatchTicket(workspace, sampleTicket());
    const back = await readPatchTicket(workspace, t.patchId);
    expect(back).toEqual(t);
  });

  it("lists all tickets", async () => {
    await createPatchTicket(workspace, sampleTicket());
    await createPatchTicket(workspace, sampleTicket());
    const all = await listPatchTickets(workspace);
    expect(all.length).toBe(2);
  });

  it("updates status + approval atomically", async () => {
    const t = await createPatchTicket(workspace, sampleTicket());
    await updatePatchTicket(workspace, t.patchId, {
      status: "awaiting_approval",
      approval: { state: "pending", decidedAt: null, decidedBy: null, note: null },
    });
    const back = await readPatchTicket(workspace, t.patchId);
    expect(back.status).toBe("awaiting_approval");
  });

  it("cleanupExpiredAndApplied removes applied (>7d) and expired (>24h) AND their payload sidecar", async () => {
    // Create three tickets: one applied (8 days ago), one expired (2 days ago), one fresh proposed
    const old = await createPatchTicket(workspace, sampleTicket());
    await writePatchPayload(workspace, old.patchId, [{ index: 0, content: "old payload" }]);
    await updatePatchTicket(workspace, old.patchId, { status: "applied", createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });

    const expiredId = await createPatchTicket(workspace, sampleTicket());
    await writePatchPayload(workspace, expiredId.patchId, [{ index: 0, content: "expired payload" }]);
    await updatePatchTicket(workspace, expiredId.patchId, { status: "expired", createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() });

    const fresh = await createPatchTicket(workspace, sampleTicket());
    await writePatchPayload(workspace, fresh.patchId, [{ index: 0, content: "fresh payload" }]);

    const removed = await cleanupExpiredAndApplied(workspace, new Date());
    expect(removed).toContain(old.patchId);
    expect(removed).toContain(expiredId.patchId);
    expect(removed).not.toContain(fresh.patchId);

    const remaining = await listPatchTickets(workspace);
    expect(remaining.map((r) => r.patchId)).toEqual([fresh.patchId]);

    // Payload sidecars for removed tickets are gone; fresh ticket's payload survives.
    await expect(readPatchPayload(workspace, old.patchId, 0)).rejects.toThrow();
    await expect(readPatchPayload(workspace, expiredId.patchId, 0)).rejects.toThrow();
    const freshPayload = await readPatchPayload(workspace, fresh.patchId, 0);
    expect(freshPayload).toBe("fresh payload");
  });

  // --- state-guarded transitions ---

  it("approvePatchTicket: only proposed | awaiting_approval are valid", async () => {
    const t = await createPatchTicket(workspace, sampleTicket());

    // proposed → approved: OK, returns updated ticket
    const a = await approvePatchTicket(workspace, t.patchId, "cli", null);
    expect(a.approval.state).toBe("approved");
    expect(a.approval.decidedBy).toBe("cli");
    expect(a.approval.decidedAt).toMatch(/^\d{4}-/);

    // approving an already-approved ticket whose status moved on (e.g., applied) must fail.
    await updatePatchTicket(workspace, t.patchId, { status: "applied" });
    await expect(approvePatchTicket(workspace, t.patchId, "gui", null))
      .rejects.toThrow(/invalid-status/);
  });

  it("approvePatchTicket: refuses expired and rejected statuses", async () => {
    const t1 = await createPatchTicket(workspace, sampleTicket());
    await updatePatchTicket(workspace, t1.patchId, { status: "expired" });
    await expect(approvePatchTicket(workspace, t1.patchId, "cli", null))
      .rejects.toThrow(/invalid-status/);

    const t2 = await createPatchTicket(workspace, sampleTicket());
    await updatePatchTicket(workspace, t2.patchId, { status: "rejected" });
    await expect(approvePatchTicket(workspace, t2.patchId, "cli", null))
      .rejects.toThrow(/invalid-status/);
  });

  it("rejectPatchTicket: flips status to rejected and approval.state to rejected", async () => {
    const t = await createPatchTicket(workspace, sampleTicket());
    const r = await rejectPatchTicket(workspace, t.patchId, "gui", "no thanks");
    expect(r.status).toBe("rejected");
    expect(r.approval.state).toBe("rejected");
    expect(r.approval.note).toBe("no thanks");
  });

  it("rejectPatchTicket: refuses applied and expired statuses", async () => {
    const t1 = await createPatchTicket(workspace, sampleTicket());
    await updatePatchTicket(workspace, t1.patchId, { status: "applied" });
    await expect(rejectPatchTicket(workspace, t1.patchId, "cli", null))
      .rejects.toThrow(/invalid-status/);
  });

  // --- payload helpers ---

  it("writePatchPayload + readPatchPayload round-trip", async () => {
    const t = await createPatchTicket(workspace, sampleTicket());
    await writePatchPayload(workspace, t.patchId, [
      { index: 0, content: "v2 content" },
    ]);
    expect(await readPatchPayload(workspace, t.patchId, 0)).toBe("v2 content");
  });

  it("InvalidPatchStateError is exported and instanceof-checkable", () => {
    const err = new InvalidPatchStateError("test");
    expect(err).toBeInstanceOf(InvalidPatchStateError);
    expect(err.code).toBe("invalid-status");
    expect(err.name).toBe("InvalidPatchStateError");
  });
});
