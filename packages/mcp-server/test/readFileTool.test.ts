import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../src/tools/readFile.js";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-readfile-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.read_file", () => {
  it("reads a file from workspace", async () => {
    await fs.writeFile(path.join(workspace, "a.txt"), "hello");
    const r = await readFileTool({ workspaceRoot: workspace, path: "a.txt" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("hello");
    expect(r.redacted).toBe(false);
  });

  it("redacts API keys in content", async () => {
    await fs.writeFile(
      path.join(workspace, "secret.txt"),
      "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    const r = await readFileTool({ workspaceRoot: workspace, path: "secret.txt" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).not.toMatch(/sk-ant-api03-[A-Z]/);
    expect(r.redacted).toBe(true);
    expect(r.redactionHits.length).toBeGreaterThan(0);
  });

  it("refuses denylisted paths", async () => {
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=x");
    const r = await readFileTool({ workspaceRoot: workspace, path: ".env" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("ignored-path");
  });

  it("refuses paths outside workspace", async () => {
    const r = await readFileTool({ workspaceRoot: workspace, path: "/etc/passwd" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("outside-workspace");
  });
});
