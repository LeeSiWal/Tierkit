/**
 * Verifies the ModelRouter HARD-FILTERS profiles whose `notGoodAt` contains the current
 * task type — not just demotes them. This is what keeps weak models out of code-* chains.
 */
import { describe, it, expect } from "vitest";
import { decideRoute } from "../src/model/ModelRouter.js";
import type { ModelProfileMap } from "../src/model/ModelProfile.js";

describe("decideRoute + notGoodAt filter", () => {
  it("excludes profiles whose notGoodAt contains the current taskType", () => {
    const profiles: ModelProfileMap = {
      llamaSmall:  { kind: "local-device", provider: "ollama", model: "llama3.2:3b", roles: [], goodAt: ["summarize", "translate"], notGoodAt: ["code-generation", "refactor", "code-review"] },
      qwenCoder:   { kind: "local-device", provider: "ollama", model: "qwen3-coder:30b", roles: [], goodAt: ["code-generation", "refactor", "code-review"] },
    };
    const r = decideRoute({
      task: { task: "review my code" },
      profiles,
      taskType: "code-review",
    });
    const localIds = r.escalationChain.filter((c) => c.tier === "local-device").map((c) => c.id);
    expect(localIds).toEqual(["qwenCoder"]);              // llamaSmall filtered out
    expect(localIds).not.toContain("llamaSmall");
  });

  it("keeps weak profile in chain when its notGoodAt does NOT match the taskType", () => {
    const profiles: ModelProfileMap = {
      llamaSmall:  { kind: "local-device", provider: "ollama", model: "llama3.2:3b", roles: [], goodAt: ["summarize"], notGoodAt: ["code-generation"] },
      qwenCoder:   { kind: "local-device", provider: "ollama", model: "qwen3-coder:30b", roles: [], goodAt: ["code-generation"] },
    };
    const r = decideRoute({
      task: { task: "summarize this article" },
      profiles,
      taskType: "summarize",
    });
    const localIds = r.escalationChain.filter((c) => c.tier === "local-device").map((c) => c.id);
    // llamaSmall stays (notGoodAt has code-generation, not summarize) and bubbles up because goodAt:summarize.
    expect(localIds[0]).toBe("llamaSmall");
    expect(localIds).toContain("qwenCoder");
  });

  it("when filter empties the primary tier, chain still starts at primary (empty) and escalates", () => {
    const profiles: ModelProfileMap = {
      llamaSmall:  { kind: "local-device",   provider: "ollama",    model: "llama3.2:3b", roles: [], notGoodAt: ["code-review"] },
      claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [], goodAt: ["code-review"] },
    };
    const r = decideRoute({
      task: { task: "review the new code" },
      profiles,
      taskType: "code-review",
      ceiling: "public-cloud",
    });
    // local-device tier now empty after filter; private-remote provides the candidate.
    expect(r.escalationChain.map((c) => c.id)).toEqual(["claudeSonnet"]);
  });
});
