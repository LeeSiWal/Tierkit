import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/usecases/initProject.js";
import { installPlugin } from "../src/usecases/installPlugin.js";
import { exportTarget } from "../src/usecases/exportTarget.js";

async function makeSamplePlugin(parent: string): Promise<string> {
  const dir = path.join(parent, "src-plugin");
  await fs.mkdir(path.join(dir, "commands"), { recursive: true });
  await fs.mkdir(path.join(dir, "rules"), { recursive: true });
  await fs.writeFile(path.join(dir, "commands/brainstorm.md"), "Brainstorm body");
  await fs.writeFile(path.join(dir, "rules/local-first.md"), "Local first body");
  await fs.writeFile(
    path.join(dir, "tierkit.plugin.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "export-test",
      name: "Export Test",
      version: "0.1.0",
      description: "export test",
      author: "tierkit",
      compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
      components: {
        commands: [
          { name: "brainstorm", file: "commands/brainstorm.md", description: "Plan", category: "planning" },
        ],
        rules: ["rules/local-first.md"],
      },
      permissions: { readFiles: true, editFiles: true },
      freedom: { level: "free" },
    }),
  );
  return dir;
}

describe("exportTarget (generic)", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("emits README, commands, and rules for an installed plugin", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-export-"));
    await initProject({ cwd: root });
    const src = await makeSamplePlugin(root);
    await installPlugin({ cwd: root, pluginPath: src });

    const result = await exportTarget({
      cwd: root,
      target: "generic",
      outDir: "dist/tierkit",
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "export-test/README.md",
      "export-test/commands/brainstorm.md",
      "export-test/rules/local-first.md",
    ]);

    const readme = await fs.readFile(path.join(root, "dist/tierkit/export-test/README.md"), "utf8");
    expect(readme).toContain("# Export Test");
    expect(readme).toContain("readFiles");
  });

  it("returns warning when no plugins installed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-export-empty-"));
    await initProject({ cwd: root });
    const result = await exportTarget({
      cwd: root,
      target: "generic",
      outDir: "dist/tierkit",
    });
    expect(result.files).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
