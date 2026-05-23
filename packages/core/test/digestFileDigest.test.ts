import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getFileDigest, getFileDigestCached, invalidateFileDigest } from "../src/digest/fileDigest.js";

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-digest-"));
  return dir;
}

describe("getFileDigest / getFileDigestCached", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempWorkspace();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("extracts important symbols + dependencies from a TS file", async () => {
    const tsFile = path.join(workspace, "src/foo.ts");
    await fs.mkdir(path.dirname(tsFile), { recursive: true });
    await fs.writeFile(
      tsFile,
      [
        `import { Bar } from "./bar";`,
        `import baz from "node:fs";`,
        ``,
        `export function helper() { return 1; }`,
        `export class Widget {}`,
        `export interface Shape { x: number; }`,
      ].join("\n"),
    );
    const d = await getFileDigest("src/foo.ts", { workspaceRoot: workspace });
    expect(d.path).toBe("src/foo.ts");
    expect(d.importantSymbols).toContain("helper");
    expect(d.importantSymbols).toContain("Widget");
    expect(d.importantSymbols).toContain("Shape");
    expect(d.dependencies).toContain("./bar");
    expect(d.dependencies).toContain("node:fs");
    expect(d.totalLines).toBeGreaterThan(0);
    expect(d.language).toBe("ts");
  });

  it("flags large file and TODO markers as risks", async () => {
    const big = path.join(workspace, "big.ts");
    const lines = [
      `// TODO: refactor this`,
      `// FIXME: this is broken`,
      ...Array.from({ length: 600 }, (_, i) => `const x${i} = ${i};`),
    ];
    await fs.writeFile(big, lines.join("\n"));
    const d = await getFileDigest("big.ts", { workspaceRoot: workspace });
    expect(d.risks.some((r) => /Large/.test(r))).toBe(true);
    expect(d.risks.some((r) => /TODO/.test(r))).toBe(true);
    expect(d.risks.some((r) => /FIXME/.test(r))).toBe(true);
  });

  it("handles missing files gracefully", async () => {
    const d = await getFileDigest("nonexistent.ts", { workspaceRoot: workspace });
    expect(d.uncertainty.length).toBeGreaterThan(0);
    expect(d.uncertainty[0]).toContain("does not exist");
    expect(d.totalLines).toBe(0);
  });

  it("achieves token savings vs source", async () => {
    const file = path.join(workspace, "big.ts");
    const body = Array.from({ length: 500 }, (_, i) => `function fn${i}() { return ${i}; }`).join("\n");
    await fs.writeFile(file, body);
    const d = await getFileDigest("big.ts", { workspaceRoot: workspace });
    expect(d.stats.savedTokens).toBeGreaterThan(0);
  });

  it("caches digest on disk: second call returns cacheHit=true", async () => {
    const file = path.join(workspace, "src/cached.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `export const x = 1;`);
    const first = await getFileDigestCached("src/cached.ts", { workspaceRoot: workspace });
    expect(first.cacheHit).toBe(false);
    const second = await getFileDigestCached("src/cached.ts", { workspaceRoot: workspace });
    expect(second.cacheHit).toBe(true);
    expect(second.hash).toBe(first.hash);
  });

  it("invalidates cache when content changes", async () => {
    const file = path.join(workspace, "src/changing.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `export const v = 1;`);
    const first = await getFileDigestCached("src/changing.ts", { workspaceRoot: workspace });
    await fs.writeFile(file, `export const v = 2;\nexport const u = 3;`);
    const second = await getFileDigestCached("src/changing.ts", { workspaceRoot: workspace });
    expect(second.cacheHit).toBe(false);
    expect(second.hash).not.toBe(first.hash);
  });

  it("forceRefresh bypasses cache", async () => {
    const file = path.join(workspace, "src/x.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `export const x = 1;`);
    await getFileDigestCached("src/x.ts", { workspaceRoot: workspace });
    const refreshed = await getFileDigestCached("src/x.ts", { workspaceRoot: workspace, forceRefresh: true });
    expect(refreshed.cacheHit).toBe(false);
  });

  it("invalidateFileDigest removes cached entry", async () => {
    const file = path.join(workspace, "src/y.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `export const y = 1;`);
    await getFileDigestCached("src/y.ts", { workspaceRoot: workspace });
    await invalidateFileDigest("src/y.ts", { workspaceRoot: workspace });
    const next = await getFileDigestCached("src/y.ts", { workspaceRoot: workspace });
    expect(next.cacheHit).toBe(false);
  });
});
