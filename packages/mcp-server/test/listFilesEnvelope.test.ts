import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listFilesTool } from "../src/tools/listFiles.js";
import { decodeCursor, type ListFilesCursor } from "@tierkit/core";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcp-lf-env-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("MCP tierkit.list_files envelope", () => {
  it("returns success envelope", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "x");
    const r = await listFilesTool({ workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    expect((r as any).tool).toBe("tierkit.list_files");
    expect((r as any).data.entries.length).toBeGreaterThan(0);
  });

  it("paginates 250 entries at default 200", async () => {
    for (let i = 0; i < 250; i++) await fs.writeFile(path.join(workspace, `f${String(i).padStart(3, "0")}.ts`), "x");
    const r1 = await listFilesTool({ workspaceRoot: workspace });
    expect((r1 as any).truncated).toBe(true);
    const cursor = (r1 as any).next.cursor;
    const r2 = await listFilesTool({ workspaceRoot: workspace, cursor });
    expect((r2 as any).truncated).toBe(false);
    expect((r2 as any).data.entries.length).toBe(50);
  });
});
