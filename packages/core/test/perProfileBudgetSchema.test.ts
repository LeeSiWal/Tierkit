import { describe, expect, it } from "vitest";
import {
  BudgetPolicySchema,
  PerProfileBudgetSchema,
  type PerProfileBudget,
} from "@tierkit/core";

describe("PerProfileBudgetSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(PerProfileBudgetSchema.parse({})).toEqual({});
  });

  it("accepts all four fields", () => {
    const b: PerProfileBudget = {
      dailyUsdLimit: 1,
      monthlyUsdLimit: 20,
      dailyInputTokenLimit: 10_000,
      monthlyInputTokenLimit: 200_000,
    };
    expect(PerProfileBudgetSchema.parse(b)).toEqual(b);
  });

  it("rejects negative USD limits", () => {
    expect(() => PerProfileBudgetSchema.parse({ monthlyUsdLimit: -1 })).toThrow();
  });

  it("rejects non-integer token limits", () => {
    expect(() => PerProfileBudgetSchema.parse({ monthlyInputTokenLimit: 1.5 })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      PerProfileBudgetSchema.parse({ monthlyOutputTokenLimit: 100 }),
    ).toThrow();
  });
});

describe("BudgetPolicySchema.perProfile", () => {
  it("accepts BudgetPolicy without perProfile (backward compat)", () => {
    const parsed = BudgetPolicySchema.parse({ monthlyUsdLimit: 30 });
    expect(parsed.perProfile).toBeUndefined();
  });

  it("accepts BudgetPolicy with perProfile keyed by profile id", () => {
    const parsed = BudgetPolicySchema.parse({
      monthlyUsdLimit: 30,
      perProfile: {
        claudeSonnet: { monthlyUsdLimit: 20, monthlyInputTokenLimit: 200_000 },
        gpt4o:        { monthlyUsdLimit: 10 },
      },
    });
    expect(parsed.perProfile?.claudeSonnet?.monthlyUsdLimit).toBe(20);
    expect(parsed.perProfile?.gpt4o?.monthlyUsdLimit).toBe(10);
  });

  it("rejects unknown fields under a perProfile entry", () => {
    expect(() =>
      BudgetPolicySchema.parse({
        perProfile: { claudeSonnet: { monthlyUsdLimit: 20, foo: 1 } },
      }),
    ).toThrow();
  });
});
