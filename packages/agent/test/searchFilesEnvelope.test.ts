import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { searchFilesTool } from "../src/tools/searchFiles.js";
import { decodeCursor, type SearchFilesCursor } from "@tierkit/core";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-sf-env-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

function ctx() { return { cwd: workspace, tierkitBaseUrl: "http://127.0.0.1:0" }; }

describe("searchFilesTool envelope", () => {
  it("returns success envelope with matches array", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "needle\nhay\nneedle");
    const res = await searchFilesTool.execute({ pattern: "needle" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(true);
    expect(env.tool).toBe("search_files");
    expect(env.data.matches.length).toBe(2);
    expect(env.truncated).toBe(false);
  });

  it("warns when pattern matches every line (.* or .+)", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "line1\nline2");
    const res = await searchFilesTool.execute({ pattern: ".*" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.warnings).toBeDefined();
    expect(env.warnings.some((w: string) => w.includes("pattern matches every line"))).toBe(true);
  });

  it("truncates at maxMatches default 50 with cursor", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `needle ${i}`).join("\n");
    await fs.writeFile(path.join(workspace, "big.ts"), lines);
    const res = await searchFilesTool.execute({ pattern: "needle" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.truncated).toBe(true);
    expect(env.data.matches.length).toBe(50);
    const decoded = decodeCursor<SearchFilesCursor>(env.next.cursor);
    expect(decoded.nextMatchIndex).toBe(50);
  });

  it("returns cursor-invalid on bad cursor", async () => {
    const res = await searchFilesTool.execute({ pattern: "x", cursor: "garbage" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("cursor-invalid");
  });
});
