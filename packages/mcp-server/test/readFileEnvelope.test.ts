import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../src/tools/readFile.js";
import { decodeCursor, type ReadFileCursor, TOOL_RESULT_ENVELOPE_VERSION } from "@tierkit/core";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcp-rf-env-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

function makeBigFile(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("MCP tierkit.read_file envelope", () => {
  it("returns success envelope shape", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "hello");
    const r = await readFileTool({ workspaceRoot: workspace, path: "a.ts" });
    expect(r.ok).toBe(true);
    expect((r as any).tool).toBe("tierkit.read_file");
    expect((r as any).version).toBe(TOOL_RESULT_ENVELOPE_VERSION);
    expect((r as any).data.content).toBe("hello");
    expect((r as any).truncated).toBe(false);
  });

  it("paginates a 900-line file with cursor", async () => {
    await fs.writeFile(path.join(workspace, "big.ts"), makeBigFile(900));
    const r1 = await readFileTool({ workspaceRoot: workspace, path: "big.ts" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const env1 = r1 as any;
    expect(env1.truncated).toBe(true);
    expect(env1.next.cursor).toBeDefined();

    const r2 = await readFileTool({ workspaceRoot: workspace, cursor: env1.next.cursor });
    const env2 = r2 as any;
    expect(env2.range.startLine).toBe(301);
  });

  it("denylisted path returns failure envelope with ignored-path", async () => {
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=x");
    const r = await readFileTool({ workspaceRoot: workspace, path: ".env" });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe("ignored-path");
  });
});
