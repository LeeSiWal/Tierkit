import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatchTool } from "../src/tools/applyPatch.js";
import { proposePatchTool } from "../src/tools/proposePatch.js";
import { readPatchTicket, updatePatchTicket } from "@tierkit/core";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-apply-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.apply_patch — happy path & freshness", () => {
  it("applies a small-risk patch without approval when policy allows", async () => {
    await fs.writeFile(path.join(workspace, "notes.md"), "old");
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "notes.md", newContent: "new" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    // Force low-risk path for this test
    await updatePatchTicket(workspace, p.patchId, { requiresApproval: false, risk: { level: "low", reasons: ["test-override"] } });

    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = await fs.readFile(path.join(workspace, "notes.md"), "utf8");
    expect(content).toBe("new");
    const ticket = await readPatchTicket(workspace, p.patchId);
    expect(ticket.status).toBe("applied");
    expect(r.files).toContain("notes.md");
  });

  it("returns stale-patch when target file changed between propose and apply", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", newContent: "v2" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await fs.writeFile(path.join(workspace, "a.ts"), "v1.5"); // user edited
    await updatePatchTicket(workspace, p.patchId, { requiresApproval: false });

    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("stale-patch");
    // Ticket NOT auto-transitioned, still proposed
    const ticket = await readPatchTicket(workspace, p.patchId);
    expect(ticket.status).toBe("proposed");
  });

  it("creates new files when beforeExists=false; new-file stale check fails if file appears", async () => {
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "new.ts", newContent: "hello" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await updatePatchTicket(workspace, p.patchId, { requiresApproval: false });

    // file appeared
    await fs.writeFile(path.join(workspace, "new.ts"), "already here");
    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("stale-patch");
  });

  it("expires tickets older than 24h", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", newContent: "v2" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await updatePatchTicket(workspace, p.patchId, {
      createdAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      requiresApproval: false,
    });

    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("expired-patch");
    const ticket = await readPatchTicket(workspace, p.patchId);
    expect(ticket.status).toBe("expired");
  });

  it("returns not-found for non-existent patchId", async () => {
    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: "patch_doesnotexist" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not-found");
  });
});
