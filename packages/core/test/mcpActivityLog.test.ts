import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logMcpActivity, readMcpActivity, type McpActivityEntry } from "../src/mcp/activityLog.js";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-actlog-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("mcp/activityLog", () => {
  it("appends one line per call, parseable as JSONL", async () => {
    await logMcpActivity(workspace, {
      tool: "tierkit.read_file",
      ok: true,
      code: null,
      durationMs: 12,
      redactionHits: 1,
      inputSummary: { path: "src/foo.ts" },
      outputSummary: { bytes: 100 },
    });
    await logMcpActivity(workspace, {
      tool: "tierkit.apply_patch",
      ok: false,
      code: "stale-patch",
      durationMs: 4,
      redactionHits: 0,
      inputSummary: { patchId: "patch_abc" },
      outputSummary: null,
    });

    const entries = await readMcpActivity(workspace);
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe("tierkit.read_file");
    expect(entries[0].ts).toMatch(/^\d{4}-/);
    expect(entries[0].type).toBe("mcp-tool");
    expect(entries[0].workspaceRoot).toBe(workspace);
    expect(entries[1].code).toBe("stale-patch");
    expect(entries[1].workspaceRoot).toBe(workspace);
  });

  it("survives malformed lines (forward-compat with future fields)", async () => {
    const file = path.join(workspace, ".tierkit/runtime/usage.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not valid json\n");
    await logMcpActivity(workspace, {
      tool: "tierkit.list_files",
      ok: true,
      code: null,
      durationMs: 1,
      redactionHits: 0,
      inputSummary: null,
      outputSummary: { count: 3 },
    });

    const entries = await readMcpActivity(workspace);
    // Malformed line is skipped, valid line is returned.
    expect(entries.map((e: McpActivityEntry) => e.tool)).toEqual(["tierkit.list_files"]);
  });
});
