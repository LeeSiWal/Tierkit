/**
 * Verifies inferGoodAt heuristics in discoverOllamaProfiles — coder model families get
 * code-generation/refactor/code-review tags, Korean-trained families get the 'korean'
 * tag, small models get summarize/translate, and unknown models get no tags (neutral).
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { discoverOllamaProfiles, _clearDiscoveryCacheForTests } from "../src/model/discoverOllamaProfiles.js";

afterEach(() => {
  vi.restoreAllMocks();
  _clearDiscoveryCacheForTests();
});

beforeEach(() => {
  delete process.env.TIERKIT_NO_DISCOVERY;
});

async function discoverWithModels(modelNames: string[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ models: modelNames.map((n) => ({ name: n })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  return discoverOllamaProfiles({ baseUrl: "http://127.0.0.1:11434", force: true });
}

describe("discoverOllamaProfiles + inferGoodAt", () => {
  it("tags Qwen3-Coder with code-generation/refactor/code-review/korean (Qwen → Korean)", async () => {
    const r = await discoverWithModels(["qwen3-coder:30b-a3b"]);
    const p = r["ollama-qwen3-coder-30b-a3b"];
    expect(p).toBeDefined();
    expect(p.goodAt).toContain("code-generation");
    expect(p.goodAt).toContain("refactor");
    expect(p.goodAt).toContain("code-review");
    expect(p.goodAt).toContain("korean");
    expect(p.goodAt).toContain("plan"); // 30b → plan tag
  });

  it("tags DeepSeek-Coder with code-* (but not korean — DeepSeek isn't Korean-strong)", async () => {
    const r = await discoverWithModels(["deepseek-coder:6.7b"]);
    const p = r["ollama-deepseek-coder-6-7b"];
    expect(p).toBeDefined();
    expect(p.goodAt).toContain("code-generation");
    expect(p.goodAt).toContain("refactor");
    expect(p.goodAt).toContain("code-review");
    expect(p.goodAt).not.toContain("korean");
  });

  it("tags small models with summarize/translate", async () => {
    const r = await discoverWithModels(["llama3.2:3b"]);
    const p = r["ollama-llama3-2-3b"];
    expect(p).toBeDefined();
    expect(p.goodAt).toContain("summarize");
    expect(p.goodAt).toContain("translate");
  });

  it("tags 70B-class models with plan", async () => {
    const r = await discoverWithModels(["llama3.1:70b"]);
    const p = r["ollama-llama3-1-70b"];
    expect(p.goodAt).toContain("plan");
  });

  it("leaves unknown families with empty/no goodAt (neutral)", async () => {
    const r = await discoverWithModels(["mystery-model:8b"]);
    const p = r["ollama-mystery-model-8b"];
    expect(p).toBeDefined();
    expect(p.goodAt).toBeUndefined();
  });

  it("codestral / starcoder / granite-code also get coder tags", async () => {
    const r = await discoverWithModels(["codestral:22b", "starcoder2:7b", "granite-code:8b"]);
    for (const id of ["ollama-codestral-22b", "ollama-starcoder2-7b", "ollama-granite-code-8b"]) {
      expect(r[id]).toBeDefined();
      expect(r[id].goodAt).toContain("code-generation");
    }
  });
});
