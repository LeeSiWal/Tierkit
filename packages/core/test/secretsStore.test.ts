import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSecretsStore } from "../src/security/SecretsStore.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-secrets-"));
});

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("SecretsStore — load + list", () => {
  it("loadIntoEnv is a no-op when the file does not exist", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    expect(store.list().entries).toEqual([]);
  });

  it("list() returns one entry per key passed via knownKeys (even if not set)", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    const r = store.list({ knownKeys: ["ANTHROPIC_API_KEY"] });
    expect(r.entries).toEqual([
      { key: "ANTHROPIC_API_KEY", set: false, masked: "" },
    ]);
  });
});

describe("SecretsStore — set", () => {
  // Windows NTFS doesn't honor POSIX file modes via Node's fs — `chmod(0o600)`
  // is a no-op and stat.mode reports the underlying ACL approximation. The
  // mode assertion runs only on POSIX OSes; the contents assertion still runs.
  const itPosix = process.platform === "win32" ? it.skip : it;
  itPosix("persists the value to disk with mode 0600", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("ANTHROPIC_API_KEY", "sk-ant-abc1234567890xyz");
    const stat = await fs.stat(path.join(tmp, "secrets.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    const body = JSON.parse(await fs.readFile(path.join(tmp, "secrets.json"), "utf8"));
    expect(body).toEqual({ ANTHROPIC_API_KEY: "sk-ant-abc1234567890xyz" });
  });

  it("masks long values with first 7 + … + last 4", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("ANTHROPIC_API_KEY", "sk-ant-abc1234567890xyz");
    const r = store.list();
    expect(r.entries[0]).toMatchObject({
      key: "ANTHROPIC_API_KEY",
      set: true,
      masked: "sk-ant-…0xyz",
    });
  });

  it("rejects invalid env var names", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await expect(store.set("not-an-env", "x")).rejects.toThrow(/invalid env var name/);
    await expect(store.set("lower_case", "x")).rejects.toThrow();
  });

  it("rejects empty values", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await expect(store.set("OPENAI_API_KEY", "")).rejects.toThrow(/non-empty/);
  });

  it("creates .gitignore with secrets.json on first set", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("OPENAI_API_KEY", "sk-ohai-1234567890xyz");
    const gi = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    expect(gi).toContain("secrets.json");
  });

  it(".gitignore append is idempotent (no duplicate lines)", async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, ".gitignore"), "other-file\nsecrets.json\n");
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("OPENAI_API_KEY", "sk-ohai-1234567890xyz");
    const gi = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    const matches = gi.match(/^secrets\.json$/gm);
    expect(matches?.length).toBe(1);
  });
});

describe("SecretsStore — env injection + remove", () => {
  it("injects file values into env on loadIntoEnv (when env is empty)", async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(
      path.join(tmp, "secrets.json"),
      JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-fromdisk1234567" }),
      { mode: 0o600 },
    );
    const env: Record<string, string | undefined> = {};
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fromdisk1234567");
  });

  it("shell env wins over file (file value not injected)", async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(
      path.join(tmp, "secrets.json"),
      JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-fromdisk1234567" }),
      { mode: 0o600 },
    );
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-fromshell" };
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fromshell");
  });

  it("set() then remove() deletes from env (since we injected it)", async () => {
    const env: Record<string, string | undefined> = {};
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    await store.set("OPENAI_API_KEY", "sk-ohai-1234567890xyz");
    expect(env.OPENAI_API_KEY).toBe("sk-ohai-1234567890xyz");
    const ok = await store.remove("OPENAI_API_KEY");
    expect(ok).toBe(true);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("remove() returns false when key was never in our store", async () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-ohai-fromshell" };
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    const ok = await store.remove("OPENAI_API_KEY");
    expect(ok).toBe(false);
    expect(env.OPENAI_API_KEY).toBe("sk-ohai-fromshell"); // untouched
  });
});
