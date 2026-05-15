import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testModel, TestModelError } from "../src/usecases/testModel.js";

async function makeProjectWithConfig(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-testmodel-"));
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => impl(url, init)));
}

describe("testModel", () => {
  let root: string;
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("throws TestModelError unknown-profile when there is no config AND the id is unknown (bundled defaults reduce this surface)", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-testmodel-noconfig-"));
    // With bundled defaults disabled by the test setup, an unknown profile id with no config
    // file present yields `unknown-profile` (not `no-config`). The error is now driven by
    // "we have no profile of this name" rather than "no file on disk".
    await expect(testModel({ cwd: root, profileId: "x" })).rejects.toMatchObject({
      name: "TestModelError",
      code: "unknown-profile",
    });
  });

  it("throws TestModelError when profileId is unknown", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: { localFast: { kind: "local-device", provider: "ollama", model: "x" } },
    });
    await expect(testModel({ cwd: root, profileId: "ghost" })).rejects.toMatchObject({
      name: "TestModelError",
      code: "unknown-profile",
    });
  });

  it("returns ok=true with modelAvailable for a healthy ollama with the model installed", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: {
          kind: "local-device",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "qwen2.5-coder:7b",
        },
      },
    });
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await testModel({ cwd: root, profileId: "localFast" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.modelAvailable).toBe(true);
      expect(r.result.modelCount).toBe(2);
    }
  });

  it("flags ollama reachable but missing model", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: {
          kind: "local-device",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "qwen2.5-coder:7b",
        },
      },
    });
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await testModel({ cwd: root, profileId: "localFast" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.modelAvailable).toBe(false);
      expect(r.result.note).toContain("ollama pull");
    }
  });

  it("returns ok=false unreachable when fetch throws", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: {
          kind: "local-device",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "x",
        },
      },
    });
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await testModel({ cwd: root, profileId: "localFast" });
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.code).toBe("unreachable");
    }
  });

  it("returns missing-api-key for openai-compatible without env var set", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        priv: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "qwen",
          apiKeyEnv: "TIERKIT_TEST_KEY_NOT_SET",
        },
      },
    });
    const r = await testModel({ cwd: root, profileId: "priv", env: {} });
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.code).toBe("missing-api-key");
  });

  it("returns unauthorized on 401 from openai-compatible", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        priv: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "qwen",
          apiKeyEnv: "K",
        },
      },
    });
    mockFetch(async () => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    const r = await testModel({ cwd: root, profileId: "priv", env: { K: "abc" } });
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.code).toBe("unauthorized");
  });

  it("returns not-implemented for an unsupported provider", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        weird: { kind: "local-device", provider: "llamafile", model: "x" },
      },
    });
    const r = await testModel({ cwd: root, profileId: "weird" });
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.code).toBe("not-implemented");
  });
});
