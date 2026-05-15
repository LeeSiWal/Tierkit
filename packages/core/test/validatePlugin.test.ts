import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePlugin } from "../src/usecases/validatePlugin.js";

async function makePluginDir(opts: { withReferencedFile?: boolean } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-validate-"));
  await fs.mkdir(path.join(dir, "commands"), { recursive: true });
  if (opts.withReferencedFile !== false) {
    await fs.writeFile(path.join(dir, "commands/x.md"), "# x");
  }
  await fs.writeFile(
    path.join(dir, "tierkit.plugin.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "uc-validate",
      name: "UC Validate",
      version: "0.1.0",
      description: "uc",
      author: "tierkit",
      compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
      components: {
        commands: [{ name: "x", file: "commands/x.md", description: "x", category: "misc" }],
      },
      permissions: { readFiles: true },
      freedom: { level: "free" },
    }),
  );
  return dir;
}

describe("validatePlugin usecase", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns ok for a valid plugin", async () => {
    dir = await makePluginDir();
    const r = await validatePlugin({ pluginPath: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.id).toBe("uc-validate");
  });

  it("returns error when manifest missing", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-validate-empty-"));
    const r = await validatePlugin({ pluginPath: dir });
    expect(r.ok).toBe(false);
  });

  it("returns error when referenced file is missing", async () => {
    dir = await makePluginDir({ withReferencedFile: false });
    const r = await validatePlugin({ pluginPath: dir });
    expect(r.ok).toBe(false);
  });
});
