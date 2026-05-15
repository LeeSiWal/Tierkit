import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/usecases/initProject.js";
import { installPlugin, PluginInstallError } from "../src/usecases/installPlugin.js";
import { listPlugins } from "../src/usecases/listPlugins.js";

async function makePluginSource(parent: string, id = "install-test"): Promise<string> {
  const dir = path.join(parent, `src-${id}`);
  await fs.mkdir(path.join(dir, "commands"), { recursive: true });
  await fs.writeFile(path.join(dir, "commands/x.md"), "x body");
  await fs.writeFile(
    path.join(dir, "tierkit.plugin.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id,
      name: id,
      version: "0.1.0",
      description: "install test",
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

describe("installPlugin", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("copies plugin into the project store and registers it", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-install-"));
    await initProject({ cwd: root });
    const src = await makePluginSource(root);

    const result = await installPlugin({ cwd: root, pluginPath: src });
    expect(result.pluginId).toBe("install-test");
    expect(result.replacedPrevious).toBe(false);

    const list = await listPlugins({ cwd: root });
    expect(list.plugins).toHaveLength(1);
    expect(list.plugins[0]?.id).toBe("install-test");

    const installedManifest = path.join(
      root,
      ".tierkit",
      "plugins",
      "install-test",
      "tierkit.plugin.json",
    );
    await expect(fs.access(installedManifest)).resolves.toBeUndefined();
  });

  it("refuses to overwrite without force=true", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-install-"));
    await initProject({ cwd: root });
    const src = await makePluginSource(root);

    await installPlugin({ cwd: root, pluginPath: src });
    await expect(installPlugin({ cwd: root, pluginPath: src })).rejects.toBeInstanceOf(
      PluginInstallError,
    );
  });

  it("overwrites when force=true", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-install-"));
    await initProject({ cwd: root });
    const src = await makePluginSource(root);

    await installPlugin({ cwd: root, pluginPath: src });
    const second = await installPlugin({ cwd: root, pluginPath: src, force: true });
    expect(second.replacedPrevious).toBe(true);
  });
});
