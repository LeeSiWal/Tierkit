import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPolicyStatusTool } from "../src/tools/getPolicyStatus.js";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-policy-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.get_policy_status", () => {
  it("returns a JSON snapshot with all required fields", async () => {
    const r = await getPolicyStatusTool({ workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // workspaceRoot is realpathed
    expect(r.workspaceRoot).toBe(await fs.realpath(workspace));
    // bundledDenylist is a non-empty array
    expect(Array.isArray(r.bundledDenylist)).toBe(true);
    expect(r.bundledDenylist.length).toBeGreaterThan(0);
    // booleans
    expect(typeof r.hasIgnoreFile).toBe("boolean");
    expect(typeof r.hasLegacyIgnoreFile).toBe("boolean");
    expect(typeof r.hasGitignore).toBe("boolean");
    expect(r.respectGitignore).toBe(true);
    // 7 tool names
    expect(r.toolNames.length).toBe(7);
    expect(r.toolNames).toContain("tierkit.run_command");
    expect(r.toolNames).toContain("tierkit.get_policy_status");
    // version is a string (dynamic — will be "0.0.0-dev" in test env)
    expect(typeof r.version).toBe("string");
    expect(r.version.length).toBeGreaterThan(0);
    // pending patches starts at 0 for empty workspace
    expect(r.pendingPatches).toBe(0);
  });

  it("counts pending patch tickets", async () => {
    const { proposePatchTool } = await import("../src/tools/proposePatch.js");
    await fs.writeFile(path.join(workspace, "x.ts"), "old");
    await proposePatchTool({ workspaceRoot: workspace, files: [{ path: "x.ts", newContent: "new" }] });
    const r = await getPolicyStatusTool({ workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pendingPatches).toBe(1);
  });

  it("version matches TIERKIT_VERSION from @tierkit/core (not hardcoded)", async () => {
    const { TIERKIT_VERSION } = await import("@tierkit/core");
    const r = await getPolicyStatusTool({ workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(TIERKIT_VERSION);
  });
});
