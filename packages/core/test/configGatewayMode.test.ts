import { describe, it, expect } from "vitest";
import { TierkitConfigSchema } from "../src/config/TierkitConfig.js";

describe("RuntimeConfigSchema.gatewayMode", () => {
  it("defaults to 'off'", () => {
    expect(TierkitConfigSchema.parse({ version: "0.1" }).runtime.gatewayMode).toBe("off");
  });
  it("accepts 'on' and 'off'", () => {
    expect(TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "on" } }).runtime.gatewayMode).toBe("on");
    expect(TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "off" } }).runtime.gatewayMode).toBe("off");
  });
  it("rejects unknown values", () => {
    expect(() => TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "auto" } })).toThrow();
  });
});

describe("RuntimeConfigSchema.gatewayTransformations", () => {
  it("defaults to off with an empty allowlist", () => {
    const parsed = TierkitConfigSchema.parse({ version: "0.1" });
    expect(parsed.runtime.gatewayTransformations.mode).toBe("off");
    expect(parsed.runtime.gatewayTransformations.toolResultEnvelope.allowlistedToolNames).toEqual([]);
  });

  it("accepts observe and envelope configuration", () => {
    expect(TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayTransformations: { mode: "observe" } } }).runtime.gatewayTransformations.mode).toBe("observe");
    const parsed = TierkitConfigSchema.parse({
      version: "0.1",
      runtime: {
        gatewayTransformations: {
          mode: "envelope",
          toolResultEnvelope: {
            allowlistedToolNames: ["SyntheticRead"],
            minInputUtf8Bytes: 100,
            preservedHeadUtf8Bytes: 10,
            preservedTailUtf8Bytes: 10,
          },
        },
      },
    });
    expect(parsed.runtime.gatewayTransformations.toolResultEnvelope.allowlistedToolNames).toEqual(["SyntheticRead"]);
  });

  it("rejects invalid transformation mode and thresholds", () => {
    expect(() => TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayTransformations: { mode: "auto" } } })).toThrow();
    expect(() => TierkitConfigSchema.parse({
      version: "0.1",
      runtime: { gatewayTransformations: { toolResultEnvelope: { minInputUtf8Bytes: -1 } } },
    })).toThrow();
  });
});

describe("RuntimeConfigSchema.measuredCompact", () => {
  it("defaults to off with official measurement disabled", () => {
    const parsed = TierkitConfigSchema.parse({ version: "0.1" });
    expect(parsed.runtime.measuredCompact.mode).toBe("off");
    expect(parsed.runtime.measuredCompact.eligibleSources.tierkitMcpCompactTools).toEqual([]);
    expect(parsed.runtime.measuredCompact.officialTokenMeasurement).toEqual({
      mode: "off",
      consentAcknowledged: false,
    });
    expect(parsed.runtime.measuredCompact.privacy.rawBaselineStorage).toBe("memory_only");
  });

  it("accepts measured compact only with official measurement consent", () => {
    const parsed = TierkitConfigSchema.parse({
      version: "0.1",
      runtime: {
        measuredCompact: {
          mode: "measured_compact",
          eligibleSources: { tierkitMcpCompactTools: ["tierkit.get_file_digest"] },
          officialTokenMeasurement: {
            mode: "anthropic_count_tokens_opt_in",
            consentAcknowledged: true,
          },
        },
      },
    });
    expect(parsed.runtime.measuredCompact.mode).toBe("measured_compact");
    expect(parsed.runtime.measuredCompact.officialTokenMeasurement.mode).toBe("anthropic_count_tokens_opt_in");
  });

  it("rejects invalid measured compact config", () => {
    expect(() => TierkitConfigSchema.parse({
      version: "0.1",
      runtime: { measuredCompact: { mode: "observe" } },
    })).toThrow();
    expect(() => TierkitConfigSchema.parse({
      version: "0.1",
      runtime: {
        measuredCompact: {
          mode: "measured_compact",
          officialTokenMeasurement: { mode: "anthropic_count_tokens_opt_in", consentAcknowledged: false },
        },
      },
    })).toThrow();
    expect(() => TierkitConfigSchema.parse({
      version: "0.1",
      runtime: { measuredCompact: { privacy: { rawBaselineStorage: "disk" } } },
    })).toThrow();
  });

  it("rejects measured compact with legacy gateway envelope enabled", () => {
    expect(() => TierkitConfigSchema.parse({
      version: "0.1",
      runtime: {
        gatewayTransformations: {
          mode: "envelope",
          toolResultEnvelope: { allowlistedToolNames: ["SyntheticRead"] },
        },
        measuredCompact: { mode: "measured_compact" },
      },
    })).toThrow();
  });
});
