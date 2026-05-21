import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL_PROFILES } from "../src/config/defaultProfiles.js";
import { ModelProfileSchema } from "../src/model/ModelProfile.js";

describe("DEFAULT_MODEL_PROFILES — local profiles notGoodAt", () => {
  it("localCoder declares notGoodAt for review/plan/refactor", () => {
    const local = (DEFAULT_MODEL_PROFILES as any).localCoder;
    expect(local.notGoodAt).toEqual(expect.arrayContaining(["code-review", "plan", "refactor"]));
  });

  it("localFast declares notGoodAt for review/plan/refactor", () => {
    const local = (DEFAULT_MODEL_PROFILES as any).localFast;
    expect(local.notGoodAt).toEqual(expect.arrayContaining(["code-review", "plan", "refactor"]));
  });
});

describe("DEFAULT_MODEL_PROFILES.claudeCode", () => {
  const claudeCode = (DEFAULT_MODEL_PROFILES as any).claudeCode;

  it("exists", () => {
    expect(claudeCode).toBeDefined();
  });

  it("is public-cloud / flat-rate / subprocess", () => {
    expect(claudeCode.kind).toBe("public-cloud");
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

  it("declares defaultMode: 'review-only' (public-cloud data flows to Anthropic cloud)", () => {
    expect(claudeCode.defaultMode).toBe("review-only");
  });

  it("omits cost (subscription paid out of band)", () => {
    expect(claudeCode.cost).toBeUndefined();
  });

  it("transport args invoke headless JSON output", () => {
    expect(claudeCode.transport.args).toEqual(["-p", "--output-format", "json"]);
  });
});
