import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { proposePatchTool } from "../src/tools/proposePatch.js";
import { readPatchTicket } from "@tierkit/core";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-propose-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.propose_patch", () => {
  it("creates a ticket for an existing file edit", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "old content");
    const r = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", newContent: "new content" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patchId).toMatch(/^patch_/);
    expect(r.files[0].beforeExists).toBe(true);
    expect(r.files[0].beforeHash).toMatch(/^sha256:/);
    expect(r.risk.level).toBe("medium");

    const ticket = await readPatchTicket(workspace, r.patchId);
    expect(ticket.status).toBe("proposed");
    expect(ticket.approval.state).toBe("pending");
  });

  it("creates a ticket for a new file with beforeExists=false", async () => {
    const r = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "new/foo.ts", newContent: "hello" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].beforeExists).toBe(false);
    expect(r.files[0].beforeHash).toBeNull();
  });

  it("refuses to mutate denylisted paths", async () => {
    const r = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: ".env", newContent: "X=Y" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("ignored-path");
  });

  it("refuses paths outside workspace", async () => {
    const r = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "../foo.ts", newContent: "x" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("outside-workspace");
  });

  it("refuses delete intent", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "old");
    const r = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "a.ts", deleted: true }],
    } as any);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("delete-not-supported");
  });

  it("classifies tierkit.config.json edits as high risk", async () => {
    await fs.writeFile(path.join(workspace, "tierkit.config.json"), "{}");
    const r = await proposePatchTool({
      workspaceRoot: workspace,
      files: [{ path: "tierkit.config.json", newContent: '{"a":1}' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.risk.level).toBe("high");
  });
});
