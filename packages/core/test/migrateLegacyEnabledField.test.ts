import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { migrateLegacyEnabledField } from "@tierkit/core";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mig-enabled-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeJson(name: string, data: unknown): Promise<string> {
  const p = path.join(tmp, name);
  await fs.writeFile(p, JSON.stringify(data, null, 2));
  return p;
}

async function readJson(p: string): Promise<any> {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

describe("migrateLegacyEnabledField", () => {
  it("folds enabled:false into disabledProfileIds and strips the field", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false },
        bar: { kind: "local-device", provider: "ollama", model: "y", roles: [] },
      },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.disabledProfileIds).toContain("foo");
    expect(after.disabledProfileIds).not.toContain("bar");
    expect(after.modelProfiles.foo.enabled).toBeUndefined();
    expect(after.modelProfiles.bar.enabled).toBeUndefined();
  });

  it("strips enabled:true (it's the default — redundant)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: true },
      },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.foo.enabled).toBeUndefined();
    expect(after.disabledProfileIds ?? []).not.toContain("foo");
  });

  it("no-op when no profile has enabled field", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [] },
      },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
  });

  it("handles workspace + user config independently", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: { foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false } },
    });
    const userPath = await writeJson("user.json", {
      version: "0.1",
      modelProfiles: { bar: { kind: "local-device", provider: "ollama", model: "y", roles: [], enabled: false } },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath,
      wsRead: { raw: await readJson(wsPath) }, userRead: { raw: await readJson(userPath) },
    });
    expect(r.changed).toBe(true);
    expect((await readJson(wsPath)).disabledProfileIds).toContain("foo");
    expect((await readJson(userPath)).disabledProfileIds).toContain("bar");
  });

  it("dedupes disabledProfileIds when id already there + enabled:false present", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      disabledProfileIds: ["foo"],
      modelProfiles: { foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false } },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.disabledProfileIds.filter((x: string) => x === "foo")).toHaveLength(1);
  });

  it("ignores null entries in modelProfiles (suppression markers)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: { foo: null, bar: { kind: "local-device", provider: "ollama", model: "y", roles: [] } },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.foo).toBeNull();
  });
});
