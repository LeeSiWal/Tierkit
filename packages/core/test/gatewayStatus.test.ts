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

describe("buildGatewayStatus", () => {
  it("reports routesEnabled=true when gatewayMode is on", () => {
    expect(buildGatewayStatus({ gatewayMode: "on", resolvedDataDir: "/tmp/data", gatewayTransformations: transformations })).toEqual({
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
    });
  });
  it("reports routesEnabled=false when off", () => {
    expect(buildGatewayStatus({ gatewayMode: "off", resolvedDataDir: "/tmp/data", gatewayTransformations: transformations }).routesEnabled).toBe(false);
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
    });
    expect(status.transformations).toEqual({
      mode: "envelope",
      toolResultEnvelopeConfigured: true,
      allowlistedToolCount: 2,
    });
  });
});
