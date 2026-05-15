import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverOllamaProfiles, _clearDiscoveryCacheForTests } from "../src/model/discoverOllamaProfiles.js";
import { loadConfig } from "../src/config/loadConfig.js";

const realFetch = globalThis.fetch;
const realNoDiscovery = process.env.TIERKIT_NO_DISCOVERY;

describe("discoverOllamaProfiles — direct", () => {
  beforeEach(() => {
    _clearDiscoveryCacheForTests();
    delete process.env.TIERKIT_NO_DISCOVERY;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realNoDiscovery !== undefined) process.env.TIERKIT_NO_DISCOVERY = realNoDiscovery;
    _clearDiscoveryCacheForTests();
  });

  it("returns one profile per installed chat-capable model", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            { name: "qwen2.5:7b-instruct" },
            { name: "gemma4:e2b" },
            { name: "qwen2.5-coder:7b" },
          ],
        }),
        { status: 200 },
      ),
    );
    const r = await discoverOllamaProfiles();
    const ids = Object.keys(r);
    expect(ids).toContain("ollama-qwen2-5-7b-instruct");
    expect(ids).toContain("ollama-gemma4-e2b");
    expect(ids).toContain("ollama-qwen2-5-coder-7b");
    expect(r["ollama-qwen2-5-coder-7b"]?.model).toBe("qwen2.5-coder:7b");
    expect(r["ollama-qwen2-5-coder-7b"]?.kind).toBe("local-device");
    expect(r["ollama-qwen2-5-coder-7b"]?.provider).toBe("ollama");
    expect(r["ollama-qwen2-5-coder-7b"]?.roles).toContain("code");
  });

  it("filters out embedding-only models", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            { name: "embeddinggemma:latest" },
            { name: "nomic-embed-text:latest" },
            { name: "bge-large:latest" },
            { name: "qwen2.5:7b-instruct" },
          ],
        }),
        { status: 200 },
      ),
    );
    const r = await discoverOllamaProfiles();
    const ids = Object.keys(r);
    expect(ids).not.toContain("ollama-embeddinggemma-latest");
    expect(ids).not.toContain("ollama-nomic-embed-text-latest");
    expect(ids).not.toContain("ollama-bge-large-latest");
    expect(ids).toContain("ollama-qwen2-5-7b-instruct");
  });

  it("respects TIERKIT_NO_DISCOVERY=1 (returns empty without probing)", async () => {
    process.env.TIERKIT_NO_DISCOVERY = "1";
    const r = await discoverOllamaProfiles();
    expect(r).toEqual({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns empty on network failure (Ollama not running)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await discoverOllamaProfiles();
    expect(r).toEqual({});
  });

  it("caches results — second call within TTL returns same data without re-probing", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }),
    );
    const a = await discoverOllamaProfiles();
    const b = await discoverOllamaProfiles();
    expect(a).toEqual(b);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("force option re-probes even when cache is fresh", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "gemma4:e2b" }] }), { status: 200 }));
    await discoverOllamaProfiles();
    const second = await discoverOllamaProfiles({ force: true });
    expect(Object.keys(second)).toContain("ollama-gemma4-e2b");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("discoverOllamaProfiles — integration with loadConfig", () => {
  beforeEach(() => {
    _clearDiscoveryCacheForTests();
    delete process.env.TIERKIT_NO_DISCOVERY;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realNoDiscovery !== undefined) process.env.TIERKIT_NO_DISCOVERY = realNoDiscovery;
    _clearDiscoveryCacheForTests();
  });

  it("discovered models show up in loadConfig output with source='discovered'", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "mistral-nemo:12b" }] }), { status: 200 }),
    );
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-discover-"));
    const userHome = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-discover-home-"));
    const r = await loadConfig(ws, { includeBundled: false, homeDirOverride: userHome });
    expect(r.config.modelProfiles["ollama-mistral-nemo-12b"]).toBeDefined();
    expect(r.profileSources["ollama-mistral-nemo-12b"]).toBe("discovered");
  });

  it("workspace profile with same id overrides discovered (config wins)", async () => {
    // Discovered would normally produce "ollama-qwen2-5-7b-instruct" but if the user already
    // has a profile with that id in workspace config, it stays as the workspace version.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b-instruct" }] }), { status: 200 }),
    );
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-discover-"));
    const userHome = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-discover-home-"));
    await fs.writeFile(
      path.join(ws, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          "ollama-qwen2-5-7b-instruct": {
            kind: "local-device",
            provider: "ollama",
            model: "my-custom-tag",
            baseUrl: "http://127.0.0.1:11434",
            roles: ["custom"],
          },
        },
      }),
    );
    const r = await loadConfig(ws, { includeBundled: false, homeDirOverride: userHome });
    expect(r.config.modelProfiles["ollama-qwen2-5-7b-instruct"]?.model).toBe("my-custom-tag");
    expect(r.profileSources["ollama-qwen2-5-7b-instruct"]).toBe("workspace");
  });

  it("runtime.discoverOllamaModels=false disables discovery", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "deepseek-coder:6.7b" }] }), { status: 200 }),
    );
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-discover-"));
    const userHome = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-discover-home-"));
    await fs.writeFile(
      path.join(ws, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        runtime: { discoverOllamaModels: false, port: 4101, dataDir: ".tierkit/runtime", host: "127.0.0.1" },
      }),
    );
    const r = await loadConfig(ws, { includeBundled: false, homeDirOverride: userHome });
    expect(r.config.modelProfiles["ollama-deepseek-coder-6-7b"]).toBeUndefined();
  });
});
