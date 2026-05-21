import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listFilesTool } from "../src/tools/listFiles.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-listfiles-"));
});
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.list_files", () => {
  it("returns workspace files", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "");
    await fs.writeFile(path.join(workspace, "b.md"), "");
    const r = await listFilesTool({ workspaceRoot: workspace, path: "." });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.name).sort()).toEqual(["a.ts", "b.md"]);
  });

  it("filters paths from bundled denylist", async () => {
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=x");
    await fs.writeFile(path.join(workspace, "a.ts"), "");
    const r = await listFilesTool({ workspaceRoot: workspace, path: "." });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.name)).not.toContain(".env");
  });

  it("respects .tierkit/ignore", async () => {
    await fs.mkdir(path.join(workspace, ".tierkit"));
    await fs.writeFile(path.join(workspace, ".tierkit/ignore"), "*.md\n");
    await fs.writeFile(path.join(workspace, "a.ts"), "");
    await fs.writeFile(path.join(workspace, "b.md"), "");
    const r = await listFilesTool({ workspaceRoot: workspace, path: "." });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.name)).toEqual(["a.ts"]);
  });

  it("refuses paths outside workspace", async () => {
    const r = await listFilesTool({ workspaceRoot: workspace, path: "/etc" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("outside-workspace");
  });
});
