import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codebaseSearchTool } from "../src/tools/codebaseSearch.js";

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-search-"));
  await fs.writeFile(path.join(workspace, "a.ts"), "export function foo() {}\nfunction bar() {}\n");
  await fs.writeFile(path.join(workspace, "b.ts"), "function foo() { return 1; }\n");
  await fs.writeFile(path.join(workspace, ".env"), "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
});
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.codebase_search", () => {
  it("finds matches across files", async () => {
    const r = await codebaseSearchTool({ workspaceRoot: workspace, query: "foo" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // v0.16 envelope: matches live in data.matches
    const files = (r as any).data.matches.map((m: any) => m.path).sort();
    expect(files).toEqual(["a.ts", "b.ts"]);
  });

  it("drops matches inside denylisted paths", async () => {
    const r = await codebaseSearchTool({ workspaceRoot: workspace, query: "ANTHROPIC" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.matches.length).toBe(0);
  });

  it("redacts secret-looking content in surviving snippets", async () => {
    await fs.writeFile(
      path.join(workspace, "test.md"),
      "see ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for reference",
    );
    const r = await codebaseSearchTool({ workspaceRoot: workspace, query: "ANTHROPIC" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const md = (r as any).data.matches.find((m: any) => m.path === "test.md");
    expect(md).toBeDefined();
    expect(md!.snippet).not.toMatch(/sk-ant-api03-[A-Z]/);
  });
});
