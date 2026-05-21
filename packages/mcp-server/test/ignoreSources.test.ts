import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadIgnoreSources, isIgnored } from "../src/ignoreSources.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-ignore-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("ignoreSources", () => {
  it("always ignores bundled denylist paths", async () => {
    const ig = await loadIgnoreSources(workspace);
    expect(isIgnored(ig, ".env")).toBe(true);
    expect(isIgnored(ig, "src/private.pem")).toBe(true);
    expect(isIgnored(ig, "id_rsa")).toBe(true);
    expect(isIgnored(ig, "secrets.json")).toBe(true);
    expect(isIgnored(ig, ".tierkit/runtime/usage.jsonl")).toBe(true);
  });

  it("respects .tierkit/ignore", async () => {
    await fs.mkdir(path.join(workspace, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".tierkit/ignore"), "*.spec.ts\nbuild/\n");
    const ig = await loadIgnoreSources(workspace);
    expect(isIgnored(ig, "foo.spec.ts")).toBe(true);
    expect(isIgnored(ig, "build/output.js")).toBe(true);
    expect(isIgnored(ig, "foo.ts")).toBe(false);
  });

  it("merges legacy .tierkit-ignore on top (union)", async () => {
    await fs.mkdir(path.join(workspace, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".tierkit/ignore"), "*.spec.ts\n");
    await fs.writeFile(path.join(workspace, ".tierkit-ignore"), "*.legacy.ts\n");
    const ig = await loadIgnoreSources(workspace);
    expect(isIgnored(ig, "foo.spec.ts")).toBe(true);
    expect(isIgnored(ig, "foo.legacy.ts")).toBe(true);
  });

  it("respects .gitignore by default", async () => {
    await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/\ndist/\n");
    const ig = await loadIgnoreSources(workspace);
    expect(isIgnored(ig, "node_modules/foo/index.js")).toBe(true);
    expect(isIgnored(ig, "dist/main.js")).toBe(true);
  });

  it("is a no-op when no ignore files exist (still bundled denylist)", async () => {
    const ig = await loadIgnoreSources(workspace);
    expect(isIgnored(ig, "src/foo.ts")).toBe(false);
    expect(isIgnored(ig, ".env")).toBe(true);
  });
});
