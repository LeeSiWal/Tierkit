import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL_PROFILES } from "../src/config/defaultProfiles.js";
import { ModelProfileSchema } from "../src/model/ModelProfile.js";

describe("DEFAULT_MODEL_PROFILES.claudeCode", () => {
  const claudeCode = (DEFAULT_MODEL_PROFILES as any).claudeCode;

  it("exists", () => {
    expect(claudeCode).toBeDefined();
  });

  it("is private-remote / flat-rate / subprocess", () => {
    expect(claudeCode.kind).toBe("private-remote");
    expect(claudeCode.paymentModel).toBe("flat-rate");
    expect(claudeCode.provider).toBe("claude-code");
    expect(claudeCode.transport.type).toBe("subprocess");
    expect(claudeCode.transport.command).toBe("claude");
  });

  it("is defaultDisabled and requiresApproval", () => {
    expect(claudeCode.defaultDisabled).toBe(true);
    expect(claudeCode.requiresApproval).toBe(true);
  });

  it("validates against ModelProfileSchema", () => {
    const r = ModelProfileSchema.safeParse(claudeCode);
    expect(r.success).toBe(true);
  });

  it("does not declare defaultMode (private-remote does not enforce it)", () => {
    expect(claudeCode.defaultMode).toBeUndefined();
  });

  it("omits cost (subscription paid out of band)", () => {
    expect(claudeCode.cost).toBeUndefined();
  });

  it("transport args invoke headless JSON output", () => {
    expect(claudeCode.transport.args).toEqual(["-p", "--output-format", "json"]);
  });
});
