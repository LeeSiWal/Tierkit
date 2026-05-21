import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateAddMissingRouterMetaFields } from "../src/config/migrateAddMissingRouterMetaFields.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-backfill-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const writeCfg = (o: object) =>
  fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(o));
const readCfg = async () =>
  JSON.parse(await fs.readFile(path.join(root, "tierkit.config.json"), "utf8"));

const bundle: any = {
  localCoder: {
    kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b",
    notGoodAt: ["code-review", "plan", "refactor"],
    roles: ["code", "review", "plan"],
  },
  claudeCode: {
    kind: "public-cloud", provider: "claude-code", model: "auto",
    goodAt: ["code-review", "planning", "debugging", "large-refactor"],
    displayName: "Claude Code",
  },
};

describe("migrateAddMissingRouterMetaFields", () => {
  it("backfills notGoodAt when workspace profile missing it", async () => {
    await writeCfg({
      version: "0.1",
      modelProfiles: {
        localCoder: { kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b", roles: ["code"] },
      },
    });
    await migrateAddMissingRouterMetaFields({ cwd: root, defaultProfiles: bundle });
    const cfg = await readCfg();
    expect(cfg.modelProfiles.localCoder.notGoodAt).toEqual(["code-review", "plan", "refactor"]);
  });

  it("does not overwrite user-set notGoodAt (preserves explicit empty array)", async () => {
    await writeCfg({
      version: "0.1",
      modelProfiles: {
        localCoder: {
          kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b",
          notGoodAt: [],
        },
      },
    });
    await migrateAddMissingRouterMetaFields({ cwd: root, defaultProfiles: bundle });
    const cfg = await readCfg();
    expect(cfg.modelProfiles.localCoder.notGoodAt).toEqual([]);
  });

  it("skips when workspace profile points at a different model than bundled", async () => {
    await writeCfg({
      version: "0.1",
      modelProfiles: {
        localCoder: { kind: "local-device", provider: "ollama", model: "deepseek-coder:33b", roles: ["code"] },
      },
    });
    await migrateAddMissingRouterMetaFields({ cwd: root, defaultProfiles: bundle });
    const cfg = await readCfg();
    expect(cfg.modelProfiles.localCoder.notGoodAt).toBeUndefined();
  });

  it("is idempotent (second run is a no-op)", async () => {
    await writeCfg({
      version: "0.1",
      modelProfiles: {
        localCoder: { kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b", roles: ["code"] },
      },
    });
    await migrateAddMissingRouterMetaFields({ cwd: root, defaultProfiles: bundle });
    const before = await readCfg();
    await migrateAddMissingRouterMetaFields({ cwd: root, defaultProfiles: bundle });
    const after = await readCfg();
    expect(after).toEqual(before);
  });

  it("no-op when tierkit.config.json is absent", async () => {
    await migrateAddMissingRouterMetaFields({ cwd: root, defaultProfiles: bundle });
    const exists = await fs.stat(path.join(root, "tierkit.config.json")).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it("backfills goodAt and displayName too", async () => {
    await writeCfg({
      version: "0.1",
      modelProfiles: {
        claudeCode: { kind: "public-cloud", provider: "claude-code", model: "auto" },
      },
    });
    await migrateAddMissingRouterMetaFields({ cwd: root, defaultProfiles: bundle });
    const cfg = await readCfg();
    expect(cfg.modelProfiles.claudeCode.goodAt).toEqual(["code-review", "planning", "debugging", "large-refactor"]);
    expect(cfg.modelProfiles.claudeCode.displayName).toBe("Claude Code");
  });
});
