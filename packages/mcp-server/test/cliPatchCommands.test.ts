import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proposePatchTool } from "../src/tools/proposePatch.js";
import { applyPatchTool } from "../src/tools/applyPatch.js";
import { readPatchTicket } from "@tierkit/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// CLI binary is dist/index.js (not dist/cli.js — confirmed in Task 1.3)
const CLI = path.resolve(__dirname, "../../cli/dist/index.js");

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-cli-patch-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit mcp patch CLI", () => {
  it("list shows pending patches", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({ workspaceRoot: workspace, files: [{ path: "a.ts", newContent: "v2" }] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const out = spawnSync("node", [CLI, "mcp", "patch", "list", "--workspace", workspace], { encoding: "utf8", timeout: 10000 });
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(p.patchId);
  });

  it("approve flips approval.state and lets apply_patch succeed", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({ workspaceRoot: workspace, files: [{ path: "a.ts", newContent: "v2" }] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // first apply → awaiting_approval
    await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });

    const out = spawnSync("node", [CLI, "mcp", "patch", "approve", p.patchId, "--workspace", workspace], { encoding: "utf8", timeout: 10000 });
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`approved ${p.patchId}`);

    const ticket = await readPatchTicket(workspace, p.patchId);
    expect(ticket.approval.state).toBe("approved");
    expect(ticket.approval.decidedBy).toBe("cli");

    const second = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(second.ok).toBe(true);
  });

  it("reject flips state and subsequent apply returns approval-rejected", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1");
    const p = await proposePatchTool({ workspaceRoot: workspace, files: [{ path: "a.ts", newContent: "v2" }] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });

    const out = spawnSync("node", [CLI, "mcp", "patch", "reject", p.patchId, "--workspace", workspace, "--note", "no thanks"], { encoding: "utf8", timeout: 10000 });
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`rejected ${p.patchId}`);

    const second = await applyPatchTool({ workspaceRoot: workspace, patchId: p.patchId });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("approval-rejected");
  });
});
