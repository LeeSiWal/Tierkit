import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/usecases/initProject.js";
import { installPlugin } from "../src/usecases/installPlugin.js";
import {
  enablePlugin,
  disablePlugin,
  removePlugin,
  PluginLifecycleError,
} from "../src/usecases/pluginLifecycle.js";

async function makeSamplePluginSource(parent: string): Promise<string> {
  const dir = path.join(parent, "src-plugin");
  await fs.mkdir(path.join(dir, "commands"), { recursive: true });
  await fs.writeFile(path.join(dir, "commands/x.md"), "x");
  await fs.writeFile(
    path.join(dir, "tierkit.plugin.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "lifecycle-test",
      name: "Lifecycle Test",
      version: "0.1.0",
      description: "x",
      author: "tierkit",
      compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
      components: { commands: [{ name: "x", file: "commands/x.md", description: "x", category: "misc" }] },
      permissions: { readFiles: true },
      freedom: { level: "free" },
    }),
  );
  return dir;
}

describe("plugin lifecycle", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("enablePlugin: adds id to activePlugins", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-lifecycle-"));
    await initProject({ cwd: root });
    const src = await makeSamplePluginSource(root);
    await installPlugin({ cwd: root, pluginPath: src });

    const r = await enablePlugin({ cwd: root, pluginId: "lifecycle-test" });
    expect(r.activePlugins).toContain("lifecycle-test");
  });

  it("enablePlugin: rejects when not installed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-lifecycle-"));
    await initProject({ cwd: root });
    await expect(enablePlugin({ cwd: root, pluginId: "ghost" })).rejects.toBeInstanceOf(
      PluginLifecycleError,
    );
  });

  it("disablePlugin: removes id from activePlugins", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-lifecycle-"));
    await initProject({ cwd: root });
    const src = await makeSamplePluginSource(root);
    await installPlugin({ cwd: root, pluginPath: src });
    await enablePlugin({ cwd: root, pluginId: "lifecycle-test" });
    const r = await disablePlugin({ cwd: root, pluginId: "lifecycle-test" });
    expect(r.activePlugins).not.toContain("lifecycle-test");
  });

  it("removePlugin: deletes installed dir + registry entry + activePlugins entry", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-lifecycle-"));
    await initProject({ cwd: root });
    const src = await makeSamplePluginSource(root);
    await installPlugin({ cwd: root, pluginPath: src });
    await enablePlugin({ cwd: root, pluginId: "lifecycle-test" });
    const installedPath = path.join(root, ".tierkit", "plugins", "lifecycle-test");
    await expect(fs.access(installedPath)).resolves.toBeUndefined();
    const r = await removePlugin({ cwd: root, pluginId: "lifecycle-test" });
    expect(r.activePlugins).not.toContain("lifecycle-test");
    await expect(fs.access(installedPath)).rejects.toBeDefined();
  });

  it("removePlugin: rejects when not installed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-lifecycle-"));
    await initProject({ cwd: root });
    await expect(removePlugin({ cwd: root, pluginId: "ghost" })).rejects.toBeInstanceOf(
      PluginLifecycleError,
    );
  });
});
