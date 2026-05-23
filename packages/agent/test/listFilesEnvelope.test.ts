import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listFilesTool } from "../src/tools/listFiles.js";
import { decodeCursor, type ListFilesCursor } from "@tierkit/core";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-lf-env-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

function ctx() { return { cwd: workspace, tierkitBaseUrl: "http://127.0.0.1:0" }; }

describe("listFilesTool envelope", () => {
  it("returns success envelope with entries array", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "x");
    await fs.writeFile(path.join(workspace, "b.ts"), "y");
    const res = await listFilesTool.execute({}, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(true);
    expect(env.tool).toBe("list_files");
    expect(env.data.entries.length).toBe(2);
    expect(env.truncated).toBe(false);
  });

  it("truncates at maxEntries default 200 and emits next.cursor", async () => {
    await Promise.all(Array.from({ length: 250 }, (_, i) => fs.writeFile(path.join(workspace, `f${i}.ts`), "x")));
    const res = await listFilesTool.execute({}, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.truncated).toBe(true);
    expect(env.data.entries.length).toBe(200);
    expect(env.next).toBeDefined();
    const decoded = decodeCursor<ListFilesCursor>(env.next.cursor);
    expect(decoded.nextIndex).toBe(200);
  });

  it("paginates via cursor: 250 entries @ maxEntries:200 → 2 chunks", async () => {
    await Promise.all(Array.from({ length: 250 }, (_, i) => fs.writeFile(path.join(workspace, `f${String(i).padStart(3, "0")}.ts`), "x")));
    const r1 = JSON.parse((await listFilesTool.execute({}, ctx() as any)).content);
    const r2 = JSON.parse((await listFilesTool.execute({ cursor: r1.next.cursor }, ctx() as any)).content);
    expect(r2.data.entries.length).toBe(50);
    expect(r2.truncated).toBe(false);
  });

  it("returns cursor-invalid on garbage cursor", async () => {
    const res = await listFilesTool.execute({ cursor: "garbage" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("cursor-invalid");
  });

  // ── PRESERVE v0.15 gating regression tests ────────────────────────────
  it("hides node_modules / .git / .tierkit / dist from listings", async () => {
    await fs.mkdir(path.join(workspace, "node_modules", "foo"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".tierkit", "runtime"), { recursive: true });
    await fs.mkdir(path.join(workspace, "dist"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src.ts"), "x");
    const res = await listFilesTool.execute({}, ctx() as any);
    const env = JSON.parse(res.content);
    const names = env.data.entries.map((e: any) => e.name);
    expect(names).toContain("src.ts");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".tierkit");
    expect(names).not.toContain("dist");
  });

  it("hides hidden dotfiles but shows .env* for code-config visibility", async () => {
    await fs.writeFile(path.join(workspace, ".env"), "x");
    await fs.writeFile(path.join(workspace, ".env.production"), "x");
    await fs.writeFile(path.join(workspace, ".rcfile"), "x");
    await fs.writeFile(path.join(workspace, "visible.ts"), "x");
    const res = await listFilesTool.execute({}, ctx() as any);
    const env = JSON.parse(res.content);
    const names = env.data.entries.map((e: any) => e.name);
    expect(names).toContain("visible.ts");
    expect(names).toContain(".env");                    // .env* visibility carveout
    expect(names).toContain(".env.production");
    expect(names).not.toContain(".rcfile");             // generic dotfile hidden
  });

  it("returns not-found when path does not exist", async () => {
    const res = await listFilesTool.execute({ path: "nonexistent" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("not-found");
  });

  it("returns not-a-directory when path is a file", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "x");
    const res = await listFilesTool.execute({ path: "a.ts" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("not-a-directory");
  });
});
