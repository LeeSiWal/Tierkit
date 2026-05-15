import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkProfileViability, partitionByViability } from "../src/model/profileViability.js";

const realFetch = globalThis.fetch;

describe("checkProfileViability", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("remote tier with set api key → viable", async () => {
    const r = await checkProfileViability(
      { kind: "private-remote", provider: "anthropic", model: "claude", apiKeyEnv: "MY_KEY", roles: [] },
      { MY_KEY: "real-key" },
    );
    expect(r.viable).toBe(true);
  });

  it("remote tier with missing api key → non-viable, reason=missing-api-key", async () => {
    const r = await checkProfileViability(
      { kind: "private-remote", provider: "anthropic", model: "claude", apiKeyEnv: "MY_KEY", roles: [] },
      {},
    );
    expect(r.viable).toBe(false);
    expect(r.reason).toBe("missing-api-key");
  });

  it("ollama with model in /api/tags → viable", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b-instruct" }] }), { status: 200 }),
    );
    const r = await checkProfileViability(
      { kind: "local-device", provider: "ollama", model: "qwen2.5:7b-instruct", baseUrl: "http://127.0.0.1:11434", roles: [] },
      {},
    );
    expect(r.viable).toBe(true);
  });

  it("ollama with model NOT in /api/tags → non-viable, reason=model-not-installed", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "llama3.2:3b" }] }), { status: 200 }),
    );
    const r = await checkProfileViability(
      { kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b", baseUrl: "http://127.0.0.1:11434", roles: [] },
      {},
    );
    expect(r.viable).toBe(false);
    expect(r.reason).toBe("model-not-installed");
  });

  it("ollama unreachable → non-viable, reason=ollama-unreachable", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await checkProfileViability(
      { kind: "local-device", provider: "ollama", model: "x", baseUrl: "http://127.0.0.1:11434", roles: [] },
      {},
    );
    expect(r.viable).toBe(false);
    expect(r.reason).toBe("ollama-unreachable");
  });

  it("ollama prefix match: profile says 'qwen2.5-coder' (no tag), installed is 'qwen2.5-coder:7b' → viable", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }] }), { status: 200 }),
    );
    const r = await checkProfileViability(
      { kind: "local-device", provider: "ollama", model: "qwen2.5-coder", baseUrl: "http://127.0.0.1:11434", roles: [] },
      {},
    );
    expect(r.viable).toBe(true);
  });
});

describe("partitionByViability", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("splits viable and non-viable candidates", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      // First Ollama probe — model NOT found
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "other" }] }), { status: 200 }))
      // Second Ollama probe — model found
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 }));
    const profiles: Record<string, Parameters<typeof checkProfileViability>[0]> = {
      missing: { kind: "local-device", provider: "ollama", model: "no-such-model", baseUrl: "http://127.0.0.1:11434", roles: [] },
      good: { kind: "local-device", provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://127.0.0.1:11434", roles: [] },
      noKey: { kind: "private-remote", provider: "anthropic", model: "claude", apiKeyEnv: "MISSING", roles: [] },
    };
    const r = await partitionByViability(
      [{ id: "missing" }, { id: "good" }, { id: "noKey" }],
      (id) => profiles[id],
      {},
    );
    expect(r.viable.map((v) => v.id)).toEqual(["good"]);
    expect(r.nonViable.map((v) => v.id).sort()).toEqual(["missing", "noKey"]);
  });
});
