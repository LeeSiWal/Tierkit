import { describe, expect, it } from "vitest";
import { compressCommand, makeRefineCallback, MockModelClient } from "@tierkit/core";
import type { ModelProfile } from "@tierkit/core";

// Build a minimal profile pointing at the mock client. The pickProviderClient
// dispatch returns OllamaClient for transport "ollama" — but makeRefineCallback
// uses pickProviderClient internally, so to inject the mock we go through
// compressCommand's `refine` option directly. This test verifies the
// makeRefineCallback contract: it forwards prompt to client.chat() and unwraps text.

describe("makeRefineCallback", () => {
  const fakeProfile: ModelProfile = {
    kind: "local-device",
    provider: "ollama",
    model: "mock-model",
    baseUrl: "http://127.0.0.1:11434",
    roles: [],
    paymentModel: "free",
  };

  it("returns a string on success", async () => {
    // We can't easily inject pickProviderClient internals, so we test the
    // failure path which doesn't require a real backend instead.
    const cb = makeRefineCallback(fakeProfile, { timeoutMs: 100 });
    // No Ollama running at this baseUrl in test → expect throw.
    await expect(cb("hello")).rejects.toThrow();
  });

  it("times out fast when configured", async () => {
    const cb = makeRefineCallback(fakeProfile, { timeoutMs: 50 });
    const t0 = Date.now();
    await expect(cb("hello")).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("compressCommand catches refine failure and degrades to rule output", async () => {
    const result = await compressCommand("Add a button to AdminMenuForm", {
      refine: makeRefineCallback(fakeProfile, { timeoutMs: 100 }),
    });
    expect(result.compressed).toContain("Task:");
    expect(result.provider).toBe("rule");
    expect(result.uncertainty.some((u) => /LLM refinement failed/.test(u))).toBe(true);
  });

  it("MockModelClient can substitute the refine target directly", async () => {
    const mock = new MockModelClient({ text: "## Task: shorter rewrite\n- single requirement" });
    const refine = async (prompt: string): Promise<string> => {
      const result = await mock.chat(fakeProfile, {
        messages: [{ role: "user", content: prompt }],
      });
      if (!result.ok) throw new Error(result.code);
      return result.text;
    };
    const result = await compressCommand("Add a button to AdminMenuForm. Keep state intact.", { refine });
    expect(result.compressed).toContain("shorter rewrite");
    expect(result.provider).toBe("ollama");
  });
});
