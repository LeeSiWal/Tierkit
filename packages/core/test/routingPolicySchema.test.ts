import { describe, it, expect } from "vitest";
import { TierkitConfigSchema } from "../src/config/TierkitConfig.js";

describe("RoutingPolicy auto-fallback fields", () => {
  it("defaults autoEscalationCeiling to 'public-cloud'", () => {
    const cfg = TierkitConfigSchema.parse({
      version: "0.1",
    });
    expect(cfg.routingPolicy.autoEscalationCeiling).toBe("public-cloud");
  });

  it("defaults budgetAwareDowngrade to true", () => {
    const cfg = TierkitConfigSchema.parse({ version: "0.1" });
    expect(cfg.routingPolicy.budgetAwareDowngrade).toBe(true);
  });

  it("defaults responseQualityCheck to true", () => {
    const cfg = TierkitConfigSchema.parse({ version: "0.1" });
    expect(cfg.routingPolicy.responseQualityCheck).toBe(true);
  });

  it("accepts user-supplied values", () => {
    const cfg = TierkitConfigSchema.parse({
      version: "0.1",
      routingPolicy: {
        autoEscalationCeiling: "local-device",
        budgetAwareDowngrade: false,
        responseQualityCheck: false,
      },
    });
    expect(cfg.routingPolicy.autoEscalationCeiling).toBe("local-device");
    expect(cfg.routingPolicy.budgetAwareDowngrade).toBe(false);
    expect(cfg.routingPolicy.responseQualityCheck).toBe(false);
  });

  it("rejects unknown autoEscalationCeiling values", () => {
    expect(() =>
      TierkitConfigSchema.parse({
        version: "0.1",
        routingPolicy: { autoEscalationCeiling: "moon" },
      }),
    ).toThrow();
  });
});
