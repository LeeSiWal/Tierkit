import { describe, it, expect } from "vitest";
import { ModelProfileSchema, SUBPROCESS_PROVIDERS } from "../src/model/ModelProfile.js";

describe("ModelProfileSchema — transport", () => {
  it("accepts a valid subprocess transport with claude-code provider", () => {
    const r = ModelProfileSchema.safeParse({
      kind: "private-remote",
      provider: "claude-code",
      model: "auto",
      paymentModel: "flat-rate",
      requiresApproval: true,
      transport: { type: "subprocess", command: "claude" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects provider=claude-code without transport", () => {
    const r = ModelProfileSchema.safeParse({
      kind: "private-remote",
      provider: "claude-code",
      model: "auto",
      paymentModel: "flat-rate",
      requiresApproval: true,
    });
    expect(r.success).toBe(false);
  });

  it("rejects transport.type=subprocess with non-subprocess provider (typo guard)", () => {
    const r = ModelProfileSchema.safeParse({
      kind: "private-remote",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      transport: { type: "subprocess", command: "claude" },
    });
    expect(r.success).toBe(false);
  });

  it("accepts a valid subprocess transport with codex-cli provider", () => {
    const r = ModelProfileSchema.safeParse({
      kind: "private-remote",
      provider: "codex-cli",
      model: "auto",
      paymentModel: "flat-rate",
      requiresApproval: true,
      transport: { type: "subprocess", command: "codex" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects provider=codex-cli without transport", () => {
    const r = ModelProfileSchema.safeParse({
      kind: "private-remote",
      provider: "codex-cli",
      model: "auto",
      paymentModel: "flat-rate",
      requiresApproval: true,
    });
    expect(r.success).toBe(false);
  });

  it("exposes SUBPROCESS_PROVIDERS as a readonly tuple", () => {
    expect(SUBPROCESS_PROVIDERS).toContain("claude-code");
    expect(SUBPROCESS_PROVIDERS).toContain("codex-cli");
  });

  it("applies transport schema defaults", () => {
    const r = ModelProfileSchema.parse({
      kind: "private-remote",
      provider: "claude-code",
      model: "auto",
      paymentModel: "flat-rate",
      requiresApproval: true,
      transport: { type: "subprocess", command: "claude" },
    });
    expect(r.transport).toMatchObject({
      type: "subprocess",
      command: "claude",
      args: [],
      healthCheckArgs: ["--version"],
      timeoutMs: 120_000,
      maxStdoutBytes: 2_000_000,
      maxStderrBytes: 524_288,
    });
  });
});
