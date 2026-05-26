import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compressCommandTool,
  getErrorDigestTool,
  getTestDigestTool,
  getJsonDigestTool,
  getFileDigestTool,
  getDiffSummaryTool,
  buildContextPackTool,
} from "../src/tools/digestTools.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-digest-tools-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("tierkit.compress_command", () => {
  it("returns an envelope with stats and compressed brief", async () => {
    const r = await compressCommandTool({ command: "Add CRUD for AdminMenuForm. Keep current structure intact." }, { workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.compressed).toContain("Task:");
    expect((r as any).data.stats.beforeTokens).toBeGreaterThan(0);
    expect((r as any).data.requirements.length).toBeGreaterThan(0);
  });

  it("rejects missing command", async () => {
    const r = await compressCommandTool({}, { workspaceRoot: workspace });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r as any).error.code).toBe("invalid-args");
  });
});

describe("tierkit.get_error_digest", () => {
  it("extracts errors and returns envelope", async () => {
    const log = "src/foo.ts:1:1 - error TS2345: bad arg";
    const r = await getErrorDigestTool({ log }, { workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.mainErrors.length).toBe(1);
    expect((r as any).data.likelyFiles).toContain("src/foo.ts");
  });
});

describe("tierkit.get_test_digest", () => {
  it("parses failed cases and counts", async () => {
    const output = "✓ pass 1\n× suite > case\n    Expected: 1\n    Received: 2\n    at /proj/src/x.ts:1:1";
    const r = await getTestDigestTool({ output }, { workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.passedCount).toBe(1);
    expect((r as any).data.failedCount).toBe(1);
  });
});

describe("tierkit.get_json_digest", () => {
  it("returns shape + field paths", async () => {
    const r = await getJsonDigestTool({ json: JSON.stringify({ a: 1, b: { c: 2 } }) }, { workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.fieldPaths).toContain("b.c");
  });
});

describe("tierkit.get_file_digest", () => {
  it("returns digest for a file inside the workspace", async () => {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src/foo.ts"), `export function bar() { return 1; }`);
    const r = await getFileDigestTool({ path: "src/foo.ts" }, { workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.importantSymbols).toContain("bar");
    expect((r as any).compactContext).toEqual({
      version: "tierkit-compact-context.v1",
      contextId: (r as any).data.id,
      contentDigest: (r as any).data.hash,
      sourceKind: "file_digest",
      recoverable: true,
      retrieveMoreTool: "tierkit.read_file",
      measurementTicket: null,
    });
  });

  it("rejects paths outside the workspace", async () => {
    const r = await getFileDigestTool({ path: "../../../etc/passwd" }, { workspaceRoot: workspace });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r as any).error.code).toBe("outside-workspace");
  });

  it("returns cacheHit=true on second call", async () => {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src/cached.ts"), `export const v = 1;`);
    const first = await getFileDigestTool({ path: "src/cached.ts" }, { workspaceRoot: workspace });
    expect(first.ok).toBe(true);
    const second = await getFileDigestTool({ path: "src/cached.ts" }, { workspaceRoot: workspace });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((second as any).data.cacheHit).toBe(true);
  });
});

describe("tierkit.get_diff_summary", () => {
  it("handles non-git directories without throwing", async () => {
    // workspace is a temp dir with no git repo; the tool should return an empty diff with uncertainty.
    const r = await getDiffSummaryTool({}, { workspaceRoot: workspace });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.uncertainty.length).toBeGreaterThan(0);
  });
});

describe("tierkit.build_context_pack", () => {
  it("builds a pack with mixed inputs", async () => {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src/x.ts"), `export const x = 1;`);
    const r = await buildContextPackTool(
      {
        command: "Update x",
        files: ["src/x.ts"],
        errorLog: "src/x.ts:1:1 - error TS1: nope",
      },
      { workspaceRoot: workspace },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.contentMd).toContain("Task Brief");
    expect((r as any).data.contentMd).toContain("Relevant File Digests");
    expect((r as any).data.contentMd).toContain("Error Digest");
    expect((r as any).data.contentMd).toContain("Output Policy for Claude Code");
  });

  it("rejects file paths outside the workspace", async () => {
    const r = await buildContextPackTool(
      { command: "x", files: ["../../etc/hosts"] },
      { workspaceRoot: workspace },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r as any).error.code).toBe("outside-workspace");
  });
});
