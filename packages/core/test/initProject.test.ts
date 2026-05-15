import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/usecases/initProject.js";

describe("initProject", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates config and registry on first run", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-init-"));
    const result = await initProject({ cwd: dir });
    expect(result.created).toContain("tierkit.config.json");
    expect(result.created).toContain(".tierkit/plugins.json");
    expect(result.skipped).toHaveLength(0);

    const cfgText = await fs.readFile(path.join(dir, "tierkit.config.json"), "utf8");
    const cfg = JSON.parse(cfgText);
    expect(cfg.version).toBe("0.1");
  });

  it("skips existing files on second run", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-init-"));
    await initProject({ cwd: dir });
    const result = await initProject({ cwd: dir });
    expect(result.skipped).toContain("tierkit.config.json");
    expect(result.skipped).toContain(".tierkit/plugins.json");
  });
});
