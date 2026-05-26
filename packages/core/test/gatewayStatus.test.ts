import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildGatewayStatus } from "../src/runtime/gatewayStatus.js";

const transformations = {
  mode: "off" as const,
  toolResultEnvelope: {
    allowlistedToolNames: [],
    minInputUtf8Bytes: 4096,
    preservedHeadUtf8Bytes: 1024,
    preservedTailUtf8Bytes: 1024,
  },
};
const measuredCompact = {
  mode: "off" as const,
  eligibleSources: { tierkitMcpCompactTools: [] },
  officialTokenMeasurement: { mode: "off" as const, consentAcknowledged: false },
  privacy: { rawBaselineStorage: "memory_only" as const, rawBaselineTtlMs: 60_000, maxRawBaselineBytes: 1_048_576 },
  reporting: { requestLevelMetrics: true, sessionAggregation: false },
};

describe("buildGatewayStatus", () => {
  it("reports routesEnabled=true when gatewayMode is on", () => {
    expect(buildGatewayStatus({ gatewayMode: "on", resolvedDataDir: "/tmp/data", gatewayTransformations: transformations, measuredCompact })).toEqual({
      gatewayMode: "on",
      routesEnabled: true,
      messagesPath: "/v1/messages",
      countTokensPath: "/v1/messages/count_tokens",
      logPath: path.join("/tmp/data", "anthropic-gateway.jsonl"),
      transformations: {
        mode: "off",
        toolResultEnvelopeConfigured: false,
        allowlistedToolCount: 0,
      },
      measuredCompact: {
        mode: "off",
        officialTokenMeasurement: "off",
        consentAcknowledged: false,
        eligibleCompactToolCount: 0,
        measurementScope: "request_level_counterfactual",
        requestLevelMeasurementAvailable: false,
        blockedReason: null,
        rawBaselineHandling: "memory_only",
        legacyEnvelopeConflict: false,
      },
    });
  });
  it("reports routesEnabled=false when off", () => {
    expect(buildGatewayStatus({ gatewayMode: "off", resolvedDataDir: "/tmp/data", gatewayTransformations: transformations, measuredCompact }).routesEnabled).toBe(false);
  });
  it("reports transformation mode and allowlist count without names", () => {
    const status = buildGatewayStatus({
      gatewayMode: "on",
      resolvedDataDir: "/tmp/data",
      gatewayTransformations: {
        ...transformations,
        mode: "envelope",
        toolResultEnvelope: { ...transformations.toolResultEnvelope, allowlistedToolNames: ["Read", "Glob"] },
      },
      measuredCompact,
    });
    expect(status.transformations).toEqual({
      mode: "envelope",
      toolResultEnvelopeConfigured: true,
      allowlistedToolCount: 2,
    });
  });

  it("reports measured compact blocked without exposing tool names", () => {
    const status = buildGatewayStatus({
      gatewayMode: "on",
      resolvedDataDir: "/tmp/data",
      gatewayTransformations: transformations,
      measuredCompact: {
        ...measuredCompact,
        mode: "measured_compact",
        eligibleSources: { tierkitMcpCompactTools: ["tierkit.get_file_digest"] },
        officialTokenMeasurement: { mode: "anthropic_count_tokens_opt_in", consentAcknowledged: true },
      },
    });
    expect(status.measuredCompact.mode).toBe("measured_compact");
    expect(status.measuredCompact.officialTokenMeasurement).toBe("anthropic_count_tokens_opt_in");
    expect(status.measuredCompact.eligibleCompactToolCount).toBe(1);
    expect(status.measuredCompact.requestLevelMeasurementAvailable).toBe(false);
    expect(status.measuredCompact.blockedReason).toContain("memory-only");
    expect(JSON.stringify(status)).not.toContain("tierkit.get_file_digest");
  });
});
