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
