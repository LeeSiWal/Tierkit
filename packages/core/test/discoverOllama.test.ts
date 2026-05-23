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
    // v0.21.12: discovery now probes multiple candidate baseUrls (localhost +
    // host.docker.internal + …) in parallel, so the first call may invoke
    // fetch N times. Cache hit on the second call MUST add zero fetches.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }),
    );
    const a = await discoverOllamaProfiles();
    const callsAfterFirst = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const b = await discoverOllamaProfiles();
    expect(a).toEqual(b);
    // Second call must be served entirely from cache — zero additional fetches.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it("coalesces concurrent callers onto a single probe (no fan-out per caller)", async () => {
    // Long-running daemons regressed when GUI's refreshAll fired ~14 parallel
    // loadConfig calls — each independently fetched 4 candidate URLs, several
    // unroutable, exhausting undici's connection pool. With coalescing, a burst
    // of concurrent callers must share ONE probe.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }),
    );
    const results = await Promise.all(Array.from({ length: 14 }, () => discoverOllamaProfiles()));
    // All callers got the same result.
    for (const r of results) expect(Object.keys(r)).toContain("ollama-qwen2-5-7b");
    // Total fetch calls bounded by candidate count (≤ 5), not multiplied by 14.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("short-circuits — returns as soon as one candidate succeeds, doesn't wait for slow ones", async () => {
    // The real-world failure: localhost responds in ~15ms but 172.17.0.1 (the
    // Docker bridge gateway candidate) blackholes the TCP connect and the
    // AbortSignal.timeout(1000) doesn't actually cancel it promptly — it can
    // sit for 3+ seconds. Before the fix, Promise.all waited for all 4 candidates,
    // making cold loadConfig take 3+ seconds. Now we resolve as soon as one
    // candidate returns ≥1 model.
    let fastResolved = false;
    let slowResolved = false;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes("127.0.0.1")) {
        return new Promise((resolve) => setTimeout(() => {
          fastResolved = true;
          resolve(new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }));
        }, 10));
      }
      // All other candidates "blackhole" for 2 seconds.
      return new Promise((resolve) => setTimeout(() => {
        slowResolved = true;
        resolve(new Response("", { status: 503 }));
      }, 2000));
    });
    const t0 = Date.now();
    const r = await discoverOllamaProfiles();
    const elapsed = Date.now() - t0;
    expect(Object.keys(r)).toContain("ollama-qwen2-5-7b");
    // We must return well before the slow probes settle. Give some margin for CI jitter.
    expect(elapsed).toBeLessThan(500);
    expect(fastResolved).toBe(true);
    expect(slowResolved).toBe(false); // slow probe still pending when we returned
  });

  it("caches negative results (no Ollama) so re-probes don't stampede", async () => {
    // Before the negative-cache fix, every loadConfig call re-probed every
    // candidate when Ollama was absent — on Mac/Windows that meant repeatedly
    // hammering host.docker.internal + 172.17.0.1 with no payoff.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
    await discoverOllamaProfiles();
    const callsAfterFirst = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    // Immediate second call should hit the cached empty result.
    const second = await discoverOllamaProfiles();
    expect(second).toEqual({});
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it("force option re-probes even when cache is fresh", async () => {
    // First round: all candidates return qwen.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }),
    );
    await discoverOllamaProfiles();
    const callsAfterFirst = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    // Second round (forced): all candidates now return gemma.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "gemma4:e2b" }] }), { status: 200 }),
    );
    const second = await discoverOllamaProfiles({ force: true });
    expect(Object.keys(second)).toContain("ollama-gemma4-e2b");
    // Force MUST cause additional probes against the candidate list.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterFirst);
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
