import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateSeedDefaultDisabled } from "../src/config/migrateSeedDefaultDisabled.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-seed-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function readCfg(): Promise<any> {
  const text = await fs.readFile(path.join(root, "tierkit.config.json"), "utf8");
  return JSON.parse(text);
}
async function writeCfg(o: object): Promise<void> {
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(o));
}

const bundledDefaults = {
  claudeCode: {
    kind: "private-remote",
    provider: "claude-code",
    model: "auto",
    defaultDisabled: true,
  },
};

describe("migrateSeedDefaultDisabled", () => {
  it("on first load, adds defaultDisabled profile id to disabledProfileIds and records seed", async () => {
    await writeCfg({ version: "0.1", modelProfiles: {} });
    await migrateSeedDefaultDisabled({ cwd: root, defaultProfiles: bundledDefaults });
    const cfg = await readCfg();
    expect(cfg.disabledProfileIds).toContain("claudeCode");
    expect(cfg.migrations?.defaultDisabledSeededProfileIds).toContain("claudeCode");
  });

  it("on second load, does not re-disable a user-enabled profile", async () => {
    await writeCfg({ version: "0.1", modelProfiles: {} });
    await migrateSeedDefaultDisabled({ cwd: root, defaultProfiles: bundledDefaults });
    const cfg1 = await readCfg();
    cfg1.disabledProfileIds = (cfg1.disabledProfileIds ?? []).filter((id: string) => id !== "claudeCode");
    await writeCfg(cfg1);
    await migrateSeedDefaultDisabled({ cwd: root, defaultProfiles: bundledDefaults });
    const cfg2 = await readCfg();
    expect(cfg2.disabledProfileIds).not.toContain("claudeCode");
  });

  it("seeds a newly-introduced defaultDisabled profile on a later run", async () => {
    await writeCfg({ version: "0.1", modelProfiles: {} });
    await migrateSeedDefaultDisabled({ cwd: root, defaultProfiles: bundledDefaults });
    const v131 = {
      ...bundledDefaults,
      codexCli: { kind: "private-remote", provider: "codex-cli", model: "auto", defaultDisabled: true },
    };
    await migrateSeedDefaultDisabled({ cwd: root, defaultProfiles: v131 });
    const cfg = await readCfg();
    expect(cfg.disabledProfileIds).toContain("codexCli");
    expect(cfg.migrations.defaultDisabledSeededProfileIds).toEqual(
      expect.arrayContaining(["claudeCode", "codexCli"]),
    );
  });

  it("is a no-op when there are no defaultDisabled profiles", async () => {
    await writeCfg({ version: "0.1", modelProfiles: {} });
    await migrateSeedDefaultDisabled({ cwd: root, defaultProfiles: {
      foo: { kind: "local-device", provider: "ollama", model: "x", baseUrl: "http://x" },
    } as any });
    const cfg = await readCfg();
    expect(cfg.disabledProfileIds ?? []).toEqual([]);
  });

  it("does nothing when tierkit.config.json is missing", async () => {
    await migrateSeedDefaultDisabled({ cwd: root, defaultProfiles: bundledDefaults });
    const exists = await fs.stat(path.join(root, "tierkit.config.json")).then(() => true, () => false);
    expect(exists).toBe(false);
  });
});
