import { describe, it, expect } from "vitest";
import { pickProviderClient } from "../src/model/providers/index.js";
import { ClaudeCodeProvider } from "../src/model/providers/claudeCode.js";

describe("pickProviderClient", () => {
  it("returns a ClaudeCodeProvider for provider=claude-code", () => {
    const c = pickProviderClient({
      kind: "private-remote",
      provider: "claude-code",
      model: "auto",
      transport: { type: "subprocess", command: "claude" },
    } as any);
    expect(c).toBeInstanceOf(ClaudeCodeProvider);
  });

  it("returns undefined for an unknown provider", () => {
    const c = pickProviderClient({ provider: "fictional-provider", model: "x" } as any);
    expect(c).toBeUndefined();
  });
});
