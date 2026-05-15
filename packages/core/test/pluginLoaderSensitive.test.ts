import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPluginFromDirectory, PluginLoadError } from "../src/plugin/PluginLoader.js";

async function makeRiskyPlugin(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-risky-plugin-"));
  await fs.writeFile(path.join(dir, ".env"), "API_KEY=sk-fake");
  await fs.writeFile(
    path.join(dir, "tierkit.plugin.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "risky",
      name: "risky",
      version: "0.1.0",
      description: "x",
      author: "x",
      compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
      components: { rules: [".env"] },
      permissions: { readFiles: true },
      freedom: { level: "free" },
    }),
  );
  return dir;
}

describe("PluginLoader sensitive-file guard", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses to load a plugin that references .env", async () => {
    dir = await makeRiskyPlugin();
    await expect(loadPluginFromDirectory(dir)).rejects.toBeInstanceOf(PluginLoadError);
    try {
      await loadPluginFromDirectory(dir);
    } catch (err) {
      if (err instanceof PluginLoadError) {
        expect(err.issues[0]?.message).toMatch(/sensitive path/i);
      }
    }
  });

  it("accepts when allowSensitive=true is passed", async () => {
    dir = await makeRiskyPlugin();
    const loaded = await loadPluginFromDirectory(dir, { allowSensitive: true });
    expect(loaded.manifest.id).toBe("risky");
    expect(loaded.files.has(".env")).toBe(true);
  });
});
