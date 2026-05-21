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

  it("tags mid-size DeepSeek-Coder (6.7B) with code-generation+refactor only; code-review is notGoodAt (needs bigger model)", async () => {
    const r = await discoverWithModels(["deepseek-coder:6.7b"]);
    const p = r["ollama-deepseek-coder-6-7b"];
    expect(p).toBeDefined();
    expect(p.goodAt).toContain("code-generation");
    expect(p.goodAt).toContain("refactor");
    expect(p.goodAt).not.toContain("code-review");      // explicit notGoodAt for mid-size
    expect(p.notGoodAt).toContain("code-review");
    expect(p.goodAt).not.toContain("korean");
  });

  it("tags small models (3B) with summarize/translate AND notGoodAt for all code-* / plan", async () => {
    const r = await discoverWithModels(["llama3.2:3b"]);
    const p = r["ollama-llama3-2-3b"];
    expect(p).toBeDefined();
    expect(p.goodAt).toContain("summarize");
    expect(p.goodAt).toContain("translate");
    expect(p.notGoodAt).toContain("code-generation");
    expect(p.notGoodAt).toContain("refactor");
    expect(p.notGoodAt).toContain("code-review");
    expect(p.notGoodAt).toContain("plan");
  });

  it("tags 70B-class models with plan", async () => {
    const r = await discoverWithModels(["llama3.1:70b"]);
    const p = r["ollama-llama3-1-70b"];
    expect(p.goodAt).toContain("plan");
  });

  it("non-coder mid-size models (7B-13B generic) get summarize/translate + notGoodAt coding (v0.13.2)", async () => {
    // mystery-model:8b is non-coder, non-small, non-large → falls into the
    // generic-mid bucket added in v0.13.2. We protect coding chains from
    // unknown mid-size generic models by default; users opt in via workspace
    // config.
    const r = await discoverWithModels(["mystery-model:8b"]);
    const p = r["ollama-mystery-model-8b"];
    expect(p).toBeDefined();
    expect(p.goodAt).toEqual(expect.arrayContaining(["summarize", "translate"]));
    expect(p.notGoodAt).toEqual(expect.arrayContaining([
      "code-generation", "refactor", "code-review", "plan",
    ]));
  });

  it("codestral / starcoder / granite-code also get coder tags", async () => {
    const r = await discoverWithModels(["codestral:22b", "starcoder2:7b", "granite-code:8b"]);
    for (const id of ["ollama-codestral-22b", "ollama-starcoder2-7b", "ollama-granite-code-8b"]) {
      expect(r[id]).toBeDefined();
      expect(r[id].goodAt).toContain("code-generation");
    }
  });
});
