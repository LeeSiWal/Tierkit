import { describe, it, expect } from "vitest";
import { ModelProfileSchema } from "../src/model/ModelProfile.js";

describe("ModelProfileSchema goodAt field", () => {
  it("accepts a profile with goodAt", () => {
    const p = ModelProfileSchema.parse({
      kind: "private-remote",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      roles: ["code"],
      goodAt: ["code-review", "korean"],
    });
    expect(p.goodAt).toEqual(["code-review", "korean"]);
  });

  it("accepts a profile WITHOUT goodAt (backward compat)", () => {
    const p = ModelProfileSchema.parse({
      kind: "local-device",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      baseUrl: "http://127.0.0.1:11434",
      roles: [],
    });
    expect(p.goodAt).toBeUndefined();
  });

  it("rejects non-string entries in goodAt", () => {
    expect(() =>
      ModelProfileSchema.parse({
        kind: "local-device",
        provider: "ollama",
        model: "x",
        roles: [],
        goodAt: [123],
      }),
    ).toThrow();
  });
});
