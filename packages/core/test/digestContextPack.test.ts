import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildContextPack } from "../src/digest/contextPack.js";

async function makeTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tierkit-pack-"));
}

describe("buildContextPack", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempWorkspace();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("builds an empty-but-valid pack with no inputs", async () => {
    const pack = await buildContextPack({ workspaceRoot: workspace });
    expect(pack.id).toMatch(/^pack_/);
    expect(pack.contentMd).toContain("Tierkit Context Pack");
    expect(pack.contentMd).toContain("Output Policy for Claude Code");
    expect(pack.requirements).toEqual([]);
    expect(pack.verdict).toBe("not-evaluated");
  });

  it("includes the task brief when command provided", async () => {
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      command: "Add CRUD for AdminMenuForm. Keep existing structure intact.",
    });
    expect(pack.taskBrief).toContain("Add CRUD");
    expect(pack.contentMd).toContain("Task Brief");
    expect(pack.requirements.length).toBeGreaterThan(0);
  });

  it("includes file digests for each file path", async () => {
    const file = path.join(workspace, "src/a.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `export function foo() { return 1; }`);
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      files: ["src/a.ts"],
    });
    expect(pack.relevantFileDigests.length).toBe(1);
    expect(pack.relevantFileDigests[0].path).toBe("src/a.ts");
    expect(pack.contentMd).toContain("src/a.ts");
  });

  it("includes diff summary when includeDiff=true", async () => {
    const pack = await buildContextPack(
      { workspaceRoot: workspace, includeDiff: true },
      { diffRunner: async () => ({ ok: true, diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }) },
    );
    expect(pack.diffSummary).toBeDefined();
    expect(pack.contentMd).toContain("Recent Git Diff Summary");
  });

  it("includes error digest when errorLog provided", async () => {
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      errorLog: "src/foo.ts:1:1 - error TS2345: oops",
    });
    expect(pack.errorDigest).toBeDefined();
    expect(pack.contentMd).toContain("Error Digest");
    expect(pack.contentMd).toContain("TS2345");
  });

  it("includes test digest when testOutput provided", async () => {
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      testOutput: "× suite > case\n  Expected: 1\n  Received: 2\n  at /proj/src/x.ts:1:1",
    });
    expect(pack.testDigest).toBeDefined();
    expect(pack.contentMd).toContain("Test Digest");
  });

  it("includes JSON digest when jsonInput provided", async () => {
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      jsonInput: JSON.stringify({ id: 1, name: "x" }),
    });
    expect(pack.jsonDigest).toBeDefined();
    expect(pack.contentMd).toContain("JSON / API Digest");
  });

  it("includes cleaned context when rawContext provided", async () => {
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      rawContext: ["✓ test 1", "✓ test 2", "Actual error: x is undefined"].join("\n"),
    });
    expect(pack.cleanedContext).toBeDefined();
    expect(pack.contentMd).toContain("Cleaned Raw Context");
    expect(pack.contentMd).toContain("Actual error");
  });

  it("aggregates uncertainty from all sections", async () => {
    const file = path.join(workspace, "missing.ts");
    // Don't create the file — should produce uncertainty in the digest.
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      command: "Maybe add a button?",
      files: ["missing.ts"],
    });
    expect(pack.uncertainty.length).toBeGreaterThan(0);
    expect(pack.contentMd).toContain("Uncertainty and Verification Required");
  });

  it("achieves nonzero compression vs raw inputs", async () => {
    const longCmd = Array.from({ length: 100 }, () => "Add CRUD for menus, and make sure to keep behavior intact.").join(" ");
    const longErr = Array.from({ length: 100 }, () => "TypeError: x is not a function").join("\n");
    const pack = await buildContextPack({
      workspaceRoot: workspace,
      command: longCmd,
      errorLog: longErr,
    });
    expect(pack.stats.savedTokens).toBeGreaterThan(0);
  });

  it("produces a full Markdown pack with all sections", async () => {
    const file = path.join(workspace, "src/x.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `export const x = 1;`);
    const pack = await buildContextPack(
      {
        workspaceRoot: workspace,
        command: "Update x to be 2.",
        files: ["src/x.ts"],
        includeDiff: true,
        errorLog: "src/x.ts:1:1 - error TS1: oops",
        testOutput: "× failing > x\n  Expected: 2\n  Received: 1",
        jsonInput: JSON.stringify({ x: 1 }),
        rawContext: "Some noise here.",
      },
      { diffRunner: async () => ({ ok: true, diff: "" }) },
    );
    expect(pack.contentMd).toContain("Task Brief");
    expect(pack.contentMd).toContain("Relevant File Digests");
    expect(pack.contentMd).toContain("Recent Git Diff Summary");
    expect(pack.contentMd).toContain("Error Digest");
    expect(pack.contentMd).toContain("Test Digest");
    expect(pack.contentMd).toContain("JSON / API Digest");
    expect(pack.contentMd).toContain("Cleaned Raw Context");
    expect(pack.contentMd).toContain("Output Policy for Claude Code");
  });
});
