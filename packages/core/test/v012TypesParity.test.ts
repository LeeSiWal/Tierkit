import { describe, expectTypeOf, expect, it } from "vitest";
import {
  PerProfileBudgetSchema,
  type PerProfileBudget,
  type ModelProfile,
} from "@tierkit/core";
import type { z } from "zod";

describe("v0.12 type/schema parity", () => {
  it("PerProfileBudget matches PerProfileBudgetSchema", () => {
    expectTypeOf<PerProfileBudget>().toEqualTypeOf<z.infer<typeof PerProfileBudgetSchema>>();
    // Compile-time only — runtime body is trivial.
  });

  it("ModelProfile.paymentModel is optional", () => {
    // If 'paymentModel' becomes required this fails to compile.
    const p: ModelProfile = {
      kind: "local-device",
      provider: "ollama",
      model: "qwen",
    };
    expect(p.paymentModel).toBeUndefined();
  });
});

// Vitest's expectTypeOf above is a compile-time assertion; the test bodies pass
// trivially. Drift between the interface and the zod schema becomes a compile error.
