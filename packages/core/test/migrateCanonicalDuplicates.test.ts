import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { migrateCanonicalDuplicates } from "@tierkit/core";

let tmp = "";

beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mig-dup-")); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

async function writeJson(name: string, data: unknown): Promise<string> {
  const p = path.join(tmp, name);
  await fs.writeFile(p, JSON.stringify(data, null, 2));
  return p;
}
async function readJson(p: string): Promise<any> {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

const baseProfile = {
  kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b",
};

describe("migrateCanonicalDuplicates", () => {
  it("collapses two workspace ids for same (provider,baseUrl,model) — richer-roles wins", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        localCoder: { ...baseProfile, roles: ["code", "review", "plan"] },
        "ollama-qwen2-5-coder-7b": { ...baseProfile, roles: ["code"] },
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.localCoder).toBeTruthy();
    expect(after.modelProfiles["ollama-qwen2-5-coder-7b"]).toBeNull();
  });

  it("workspace wins over user for same identity", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: { wsOne: { ...baseProfile, roles: ["code"] } },
    });
    const userPath = await writeJson("user.json", {
      version: "0.1",
      modelProfiles: { userOne: { ...baseProfile, roles: ["code", "review"] } },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath,
      wsRead: { raw: await readJson(wsPath) }, userRead: { raw: await readJson(userPath) },
    });
    expect(r.changed).toBe(true);
    expect((await readJson(wsPath)).modelProfiles.wsOne).toBeTruthy();
    expect((await readJson(userPath)).modelProfiles.userOne).toBeNull();
  });

  it("no-op when no duplicates", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { ...baseProfile, model: "qwen2.5-coder:7b" },
        bar: { ...baseProfile, model: "llama3.2:3b" },
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
  });

  it("ignores null entries (already suppressed)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { ...baseProfile, roles: ["code"] },
        bar: null,
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
  });

  it("tiebreaker: same source AND same roles count → keeps first-encountered (insertion order)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        first: { ...baseProfile, roles: ["code"] },
        second: { ...baseProfile, roles: ["code"] },
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.first).toBeTruthy();
    expect(after.modelProfiles.second).toBeNull();
  });
});
