import { describe, it, expect } from "vitest";
import { buildEscalationChain } from "../src/model/ModelRouter.js";
import type { ModelProfileMap } from "../src/model/ModelProfile.js";

const subprocessTransport = {
  type: "subprocess" as const,
  command: "claude",
  args: [],
  healthCheckArgs: ["--version"],
  timeoutMs: 1, maxStdoutBytes: 1, maxStderrBytes: 1,
};

describe("buildEscalationChain — notGoodAt empties tier, escalates", () => {
  it("when all local-device profiles notGoodAt the taskType, private-remote wins", () => {
    const profiles: ModelProfileMap = {
      localCoder: {
        kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b", roles: [],
        notGoodAt: ["code-review"],
      },
      localFast: {
        kind: "local-device", provider: "ollama", model: "llama3.2:3b", roles: [],
        notGoodAt: ["code-review"],
      },
      claudeCode: {
        kind: "private-remote", provider: "claude-code", model: "auto",
        paymentModel: "flat-rate", requiresApproval: true, roles: [],
        transport: subprocessTransport,
      },
    };
    const chain = buildEscalationChain(profiles, "local-device", "public-cloud", "code-review");
    const ids = chain.map((c) => c.id);

    // local-device profiles are filtered out for "code-review"
    expect(ids).not.toContain("localCoder");
    expect(ids).not.toContain("localFast");
    // claudeCode is first
    expect(ids[0]).toBe("claudeCode");
  });

  it("for general taskType (no notGoodAt match), local-device wins as before", () => {
    const profiles: ModelProfileMap = {
      localCoder: {
        kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b", roles: [],
        notGoodAt: ["code-review"],
      },
      claudeCode: {
        kind: "private-remote", provider: "claude-code", model: "auto",
        paymentModel: "flat-rate", requiresApproval: true, roles: [],
        transport: subprocessTransport,
      },
    };
    const chain = buildEscalationChain(profiles, "local-device", "public-cloud", "general");
    expect(chain[0]!.id).toBe("localCoder");
  });
});
