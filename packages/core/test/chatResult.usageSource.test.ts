import { describe, it, expect } from "vitest";
import type { ChatResult } from "../src/model/providers/chatTypes.js";

describe("ChatResult shape includes usageSource", () => {
  it("compiles when usageSource is set on ChatOk", () => {
    const r: ChatResult = {
      ok: true,
      text: "x",
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 0,
      model: "m",
      usageSource: "provider-reported",
    };
    expect(r.ok && r.usageSource).toBe("provider-reported");
  });

  it("accepts 'estimated' as a valid usageSource", () => {
    const r: ChatResult = {
      ok: true,
      text: "x",
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 0,
      model: "m",
      usageSource: "estimated",
    };
    expect(r.ok && r.usageSource).toBe("estimated");
  });
});
