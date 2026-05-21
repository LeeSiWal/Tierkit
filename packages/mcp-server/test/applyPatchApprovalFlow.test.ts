import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatchTool } from "../src/tools/applyPatch.js";
import { proposePatchTool } from "../src/tools/proposePatch.js";
import { readPatchTicket, updatePatchTicket, approvePatchTicket } from "@tierkit/core";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-flow-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.apply_patch — retry approval flow", () => {
  it("first call returns approval-required + transitions to awaiting_approval", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", newContent: "v2" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("approval-required");
    expect(r.approval?.cliCommand).toMatch(/tierkit mcp patch approve/);
    expect(r.approval?.guiPath).toContain("/v1/mcp/patches/");

    const ticket = await readPatchTicket(workspace, p.patchId);
    expect(ticket.status).toBe("awaiting_approval");
    expect(ticket.approval.state).toBe("pending");
  });

  it("subsequent call after approval applies", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", newContent: "v2" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId }); // transitions to awaiting_approval

    // simulate CLI approve via the state-guarded helper
    await approvePatchTicket(workspace, p.patchId, "cli", null);

    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = await fs.readFile(path.join(workspace, "a.ts"), "utf8");
    expect(content).toBe("v2");
    const ticket = await readPatchTicket(workspace, p.patchId);
    expect(ticket.status).toBe("applied");
  });

  it("rejection path returns approval-rejected", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", newContent: "v2" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });

    await updatePatchTicket(workspace, p.patchId, {
      approval: { state: "rejected", decidedAt: new Date().toISOString(), decidedBy: "gui", note: "risky" },
    });

    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("approval-rejected");
    const ticket = await readPatchTicket(workspace, p.patchId);
    expect(ticket.status).toBe("rejected");
  });

  it("refuses to apply if the payload sidecar was tampered with after propose", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", newContent: "v2-original" }],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    // approve so we exit the gate
    await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId }); // → awaiting_approval
    await approvePatchTicket(workspace, p.patchId, "cli", null);

    // tamper with the sidecar payload — simulating an attacker swapping content between propose and apply
    const sidecar = path.join(
      workspace, ".tierkit/runtime/mcp/patches", p.patchId + ".payload", "f0.txt",
    );
    await fs.writeFile(sidecar, "v2-tampered");

    const r = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("payload-corrupt");

    // Source file must NOT have been touched.
    expect(await fs.readFile(path.join(workspace, "a.ts"), "utf8")).toBe("v1");
  });
});
