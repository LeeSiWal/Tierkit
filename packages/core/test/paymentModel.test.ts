import { describe, expect, it } from "vitest";
import {
  PAYMENT_MODELS,
  effectivePaymentModel,
  type ModelProfile,
  type PaymentModel,
} from "@tierkit/core";

const baseProfile = (kind: ModelProfile["kind"]): ModelProfile => ({
  kind,
  provider: "ollama",
  model: "test",
});

describe("PaymentModel", () => {
  it("exports the three values", () => {
    expect(PAYMENT_MODELS).toEqual(["free", "flat-rate", "per-token"]);
  });
});

describe("effectivePaymentModel", () => {
  it("returns explicit paymentModel when set", () => {
    const p: ModelProfile = { ...baseProfile("public-cloud"), paymentModel: "flat-rate" };
    expect(effectivePaymentModel(p)).toBe("flat-rate");
  });

  it("derives 'free' for local-device when unset", () => {
    expect(effectivePaymentModel(baseProfile("local-device"))).toBe("free");
  });

  it("derives 'free' for private-remote when unset", () => {
    expect(effectivePaymentModel(baseProfile("private-remote"))).toBe("free");
  });

  it("derives 'per-token' for public-cloud when unset", () => {
    expect(effectivePaymentModel(baseProfile("public-cloud"))).toBe("per-token");
  });

  it("explicit override beats the kind default", () => {
    // A private-remote rented per-token endpoint, opting in explicitly:
    const p: ModelProfile = { ...baseProfile("private-remote"), paymentModel: "per-token" };
    expect(effectivePaymentModel(p)).toBe("per-token");
    // A local-device that the user wants to count as flat-rate (rented):
    const q: ModelProfile = { ...baseProfile("local-device"), paymentModel: "flat-rate" };
    expect(effectivePaymentModel(q)).toBe("flat-rate");
  });
});
