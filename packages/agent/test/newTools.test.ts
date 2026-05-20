import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { searchAndReplaceTool, codebaseSearchTool, listFilesTool } from "../src/tools/index.js";
import type { AgentContext } from "../src/types.js";

async function makeTempCwd(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-agent-tools-"));
}

function ctx(cwd: string): AgentContext {
  return { cwd, env: {}, tierkitBaseUrl: "http://127.0.0.1:65535" }; // unreachable port → gates fail open
}

describe("search_and_replace", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await makeTempCwd(); });
  afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

  test("replaces every match and reports count", async () => {
    await fs.writeFile(path.join(cwd, "a.ts"), "const x = oldName + oldName + 'oldName';");
    const r = await searchAndReplaceTool.execute(
      { path: "a.ts", pattern: "oldName", replacement: "newName" },
      ctx(cwd),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Replaced 3 occurrence");
    expect(await fs.readFile(path.join(cwd, "a.ts"), "utf8")).toBe("const x = newName + newName + 'newName';");
  });

  test("fails when pattern doesn't match", async () => {
    await fs.writeFile(path.join(cwd, "a.ts"), "const x = 1;");
    const r = await searchAndReplaceTool.execute(
      { path: "a.ts", pattern: "NOMATCH", replacement: "x" },
      ctx(cwd),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("no-match");
  });

  test("rejects path-escape attempts", async () => {
    const r = await searchAndReplaceTool.execute(
      { path: "../../../etc/passwd", pattern: "root", replacement: "x" },
      ctx(cwd),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("path-escape");
  });
});

describe("codebase_search", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await makeTempCwd(); });
  afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

  test("ranks files by overlapping keywords", async () => {
    await fs.writeFile(
      path.join(cwd, "auth.ts"),
      "export function loginUser(email, password) {\n  // log the user in via session token\n  return session;\n}\n",
    );
    await fs.writeFile(
      path.join(cwd, "unrelated.ts"),
      "export const colors = { red: 1, blue: 2 };\n",
    );
    const r = await codebaseSearchTool.execute(
      { query: "where does the user login session happen" },
      ctx(cwd),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("auth.ts");
    expect(r.content).not.toContain("unrelated.ts");
  });

  test("rejects query with no usable tokens", async () => {
    const r = await codebaseSearchTool.execute({ query: "a b c" }, ctx(cwd));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid-query");
  });
});

describe("list_files", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await makeTempCwd(); });
  afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

  test("skips arbitrary dotfiles/dotdirs (e.g. .metadata, .claude), keeps .env*", async () => {
    // Project-y files
    await fs.writeFile(path.join(cwd, "package.json"), "{}");
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src/index.ts"), "");
    // Junk dotdirs that should be skipped (and NOT recursed into)
    await fs.mkdir(path.join(cwd, ".metadata/.plugins/some.huge.tree"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".metadata/.plugins/some.huge.tree/x.txt"), "");
    await fs.mkdir(path.join(cwd, ".claude"));
    await fs.writeFile(path.join(cwd, ".claude/state.json"), "{}");
    // Env files that SHOULD show
    await fs.writeFile(path.join(cwd, ".env"), "FOO=bar");
    await fs.writeFile(path.join(cwd, ".env.example"), "FOO=");

    const r = await listFilesTool.execute({ path: ".", recursive: true }, ctx(cwd));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("package.json");
    expect(r.content).toContain("src/index.ts");
    expect(r.content).toContain(".env");
    expect(r.content).toContain(".env.example");
    expect(r.content).not.toContain(".metadata");
    expect(r.content).not.toContain(".claude");
    expect(r.content).not.toContain("some.huge.tree");
  });
});
