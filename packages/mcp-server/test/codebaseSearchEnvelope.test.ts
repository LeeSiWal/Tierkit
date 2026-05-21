import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codebaseSearchTool } from "../src/tools/codebaseSearch.js";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcp-cs-env-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("MCP tierkit.codebase_search envelope", () => {
  it("returns success envelope with matches", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "needle\nhay\nneedle");
    const r = await codebaseSearchTool({ workspaceRoot: workspace, query: "needle" });
    expect(r.ok).toBe(true);
    expect((r as any).tool).toBe("tierkit.codebase_search");
    expect((r as any).data.matches.length).toBe(2);
  });

  it("emits pattern-too-broad warning for .*", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "x");
    const r = await codebaseSearchTool({ workspaceRoot: workspace, query: ".*" });
    expect((r as any).warnings?.some((w: string) => w.includes("pattern matches every line"))).toBe(true);
  });
});
