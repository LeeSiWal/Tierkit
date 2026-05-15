import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPluginFromDirectory, PluginLoadError } from "../src/plugin/PluginLoader.js";

async function makeTempPlugin(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-plugin-loader-"));
  await fs.mkdir(path.join(dir, "commands"), { recursive: true });
  await fs.mkdir(path.join(dir, "rules"), { recursive: true });
  await fs.writeFile(path.join(dir, "commands/brainstorm.md"), "# brainstorm");
  await fs.writeFile(path.join(dir, "rules/local-first.md"), "# local-first");
  await fs.writeFile(
    path.join(dir, "tierkit.plugin.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "loader-test",
      name: "Loader Test",
      version: "0.1.0",
      description: "loader test",
      author: "tierkit",
      compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
      components: {
        commands: [{ name: "brainstorm", file: "commands/brainstorm.md", description: "x", category: "planning" }],
        rules: ["rules/local-first.md"],
      },
      permissions: { readFiles: true },
      freedom: { level: "free" },
    }),
  );
  return dir;
}

describe("loadPluginFromDirectory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempPlugin();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads manifest and referenced files", async () => {
    const plugin = await loadPluginFromDirectory(dir);
    expect(plugin.manifest.id).toBe("loader-test");
    expect(plugin.files.get("commands/brainstorm.md")).toContain("brainstorm");
    expect(plugin.files.get("rules/local-first.md")).toContain("local-first");
  });

  it("fails when a referenced file is missing", async () => {
    await fs.rm(path.join(dir, "rules/local-first.md"));
    await expect(loadPluginFromDirectory(dir)).rejects.toBeInstanceOf(PluginLoadError);
  });

  it("blocks path traversal in referenced file paths", async () => {
    const manifestPath = path.join(dir, "tierkit.plugin.json");
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    raw.components.rules = ["../escape.md"];
    await fs.writeFile(manifestPath, JSON.stringify(raw));
    await expect(loadPluginFromDirectory(dir)).rejects.toBeInstanceOf(PluginLoadError);
  });

  it("rejects an invalid manifest", async () => {
    await fs.writeFile(path.join(dir, "tierkit.plugin.json"), '{"oops": true}');
    await expect(loadPluginFromDirectory(dir)).rejects.toBeInstanceOf(PluginLoadError);
  });
});
