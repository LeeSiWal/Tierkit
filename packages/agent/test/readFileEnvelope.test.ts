import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock gateSensitivePath so envelope tests don't depend on the daemon being up.
// (Sensitive-path BLOCKED behavior is exercised separately in tierkitGates.test.ts.)
vi.mock("../src/tools/tierkitGates.js", () => ({
  gateSensitivePath: vi.fn(async () => ({ blocked: false })),
}));

import { readFileTool } from "../src/tools/readFile.js";
import {
  encodeCursor,
  decodeCursor,
  type ReadFileCursor,
  TOOL_RESULT_ENVELOPE_VERSION,
} from "@tierkit/core";

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-rf-env-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(cwd = workspace) {
  return { cwd, tierkitBaseUrl: "http://127.0.0.1:0" };
}

function makeBigFile(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("readFileTool envelope", () => {
  it("returns success envelope for a small file (no truncation)", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "v1\nv2\nv3");
    const res = await readFileTool.execute({ path: "a.ts" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(true);
    expect(env.tool).toBe("read_file");
    expect(env.version).toBe(TOOL_RESULT_ENVELOPE_VERSION);
    expect(env.data.path).toBe("a.ts");
    expect(env.data.content).toBe("v1\nv2\nv3");
    expect(env.truncated).toBe(false);
    expect(env.next).toBeUndefined();
  });

  it("truncates to maxLines (default 300) and emits next.cursor with fileHash", async () => {
    await fs.writeFile(path.join(workspace, "big.ts"), makeBigFile(900));
    const res = await readFileTool.execute({ path: "big.ts" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(true);
    expect(env.truncated).toBe(true);
    expect(env.range.startLine).toBe(1);
    expect(env.range.endLine).toBe(300);
    expect(env.size.linesReturned).toBe(300);
    expect(env.size.totalLines).toBe(900);
    expect(env.size.remainingLines).toBe(600);
    expect(env.next).toBeDefined();
    expect(env.next.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(env.next.suggestedCall.tool).toBe("read_file");
    expect(env.next.suggestedCall.args.cursor).toBe(env.next.cursor);

    const decoded = decodeCursor<ReadFileCursor>(env.next.cursor);
    expect(decoded.tool).toBe("read_file");
    expect(decoded.path).toBe("big.ts");
    expect(decoded.nextStartLine).toBe(301);
    expect(decoded.maxLines).toBe(300);
    expect(decoded.fileHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("clamps maxLines > 1000 to 1000 and emits a warning", async () => {
    await fs.writeFile(path.join(workspace, "big.ts"), makeBigFile(2000));
    const res = await readFileTool.execute({ path: "big.ts", maxLines: 5000 }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(true);
    expect(env.size.linesReturned).toBe(1000);
    expect(env.warnings).toContain("maxLines clamped to 1000");
  });

  it("paginates correctly via cursor: 900 lines @ maxLines:300 → 3 chunks", async () => {
    await fs.writeFile(path.join(workspace, "page.ts"), makeBigFile(900));
    const r1 = JSON.parse((await readFileTool.execute({ path: "page.ts" }, ctx() as any)).content);
    expect(r1.range.endLine).toBe(300);
    expect(r1.truncated).toBe(true);

    const r2 = JSON.parse((await readFileTool.execute({ cursor: r1.next.cursor }, ctx() as any)).content);
    expect(r2.range.startLine).toBe(301);
    expect(r2.range.endLine).toBe(600);
    expect(r2.truncated).toBe(true);

    const r3 = JSON.parse((await readFileTool.execute({ cursor: r2.next.cursor }, ctx() as any)).content);
    expect(r3.range.startLine).toBe(601);
    expect(r3.range.endLine).toBe(900);
    expect(r3.truncated).toBe(false);
    expect(r3.next).toBeUndefined();
  });

  it("returns stale-cursor when file changes between issue and use", async () => {
    await fs.writeFile(path.join(workspace, "ch.ts"), makeBigFile(900));
    const r1 = JSON.parse((await readFileTool.execute({ path: "ch.ts" }, ctx() as any)).content);

    // Modify the file
    await fs.writeFile(path.join(workspace, "ch.ts"), makeBigFile(900) + "\nmutation");

    const r2 = JSON.parse((await readFileTool.execute({ cursor: r1.next.cursor }, ctx() as any)).content);
    expect(r2.ok).toBe(false);
    expect(r2.error.code).toBe("stale-cursor");
  });

  it("returns stale-cursor (not not-found) when file behind cursor was deleted", async () => {
    await fs.writeFile(path.join(workspace, "del.ts"), makeBigFile(900));
    const r1 = JSON.parse((await readFileTool.execute({ path: "del.ts" }, ctx() as any)).content);
    expect(r1.ok).toBe(true);

    await fs.rm(path.join(workspace, "del.ts"));

    const r2 = JSON.parse((await readFileTool.execute({ cursor: r1.next.cursor }, ctx() as any)).content);
    expect(r2.ok).toBe(false);
    expect(r2.error.code).toBe("stale-cursor");
  });

  it("returns cursor-invalid on garbage cursor", async () => {
    await fs.writeFile(path.join(workspace, "x.ts"), "ok");
    const res = await readFileTool.execute({ cursor: "not-a-real-cursor" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("cursor-invalid");
  });

  it("ignores path/startLine/maxLines when cursor is present", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), makeBigFile(900));
    const r1 = JSON.parse((await readFileTool.execute({ path: "a.ts" }, ctx() as any)).content);
    // pass conflicting args alongside cursor — cursor wins
    const r2 = JSON.parse((await readFileTool.execute({
      cursor: r1.next.cursor,
      path: "different.ts",
      startLine: 999,
      maxLines: 1,
    }, ctx() as any)).content);
    expect(r2.ok).toBe(true);
    expect(r2.data.path).toBe("a.ts");        // cursor's path, not args.path
    expect(r2.range.startLine).toBe(301);     // cursor's offset, not args.startLine
  });

  it("returns not-found failure envelope when path does not exist", async () => {
    const res = await readFileTool.execute({ path: "missing.ts" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(false);
    expect(env.tool).toBe("read_file");
    expect(env.error.code).toBe("not-found");
  });
});
