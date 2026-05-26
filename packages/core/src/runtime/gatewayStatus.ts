import { gatewayLogPath } from "./gatewayLog.js";
import type { GatewayTransformationsConfig, MeasuredCompactConfig } from "../config/TierkitConfig.js";

export interface GatewayStatusInput {
  gatewayMode: "off" | "on";
  resolvedDataDir: string;
  gatewayTransformations: GatewayTransformationsConfig;
  measuredCompact: MeasuredCompactConfig;
}

export interface GatewayStatus {
  gatewayMode: "off" | "on";
  routesEnabled: boolean;
  messagesPath: string;
  countTokensPath: string;
  logPath: string;
  transformations: {
    mode: "off" | "observe" | "envelope";
    toolResultEnvelopeConfigured: boolean;
    allowlistedToolCount: number;
  };
  measuredCompact: {
    mode: "off" | "measured_compact";
    officialTokenMeasurement: "off" | "anthropic_count_tokens_opt_in";
    consentAcknowledged: boolean;
    eligibleCompactToolCount: number;
    measurementScope: "request_level_counterfactual";
    requestLevelMeasurementAvailable: boolean;
    blockedReason: string | null;
    rawBaselineHandling: "memory_only";
    legacyEnvelopeConflict: boolean;
  };
}

export function buildGatewayStatus(input: GatewayStatusInput): GatewayStatus {
  return {
    gatewayMode: input.gatewayMode,
    routesEnabled: input.gatewayMode === "on",
    messagesPath: "/v1/messages",
    countTokensPath: "/v1/messages/count_tokens",
    logPath: gatewayLogPath(input.resolvedDataDir),
    transformations: {
      mode: input.gatewayTransformations.mode,
      toolResultEnvelopeConfigured: input.gatewayTransformations.toolResultEnvelope.allowlistedToolNames.length > 0,
      allowlistedToolCount: input.gatewayTransformations.toolResultEnvelope.allowlistedToolNames.length,
    },
    measuredCompact: {
      mode: input.measuredCompact.mode,
      officialTokenMeasurement: input.measuredCompact.officialTokenMeasurement.mode,
      consentAcknowledged: input.measuredCompact.officialTokenMeasurement.consentAcknowledged,
      eligibleCompactToolCount: input.measuredCompact.eligibleSources.tierkitMcpCompactTools.length,
      measurementScope: "request_level_counterfactual",
      requestLevelMeasurementAvailable: false,
      blockedReason:
        input.measuredCompact.mode === "off"
          ? null
          : "MCP compact tools and the Anthropic Gateway do not share a memory-only raw-baseline registry in the current architecture.",
      rawBaselineHandling: input.measuredCompact.privacy.rawBaselineStorage,
      legacyEnvelopeConflict:
        input.measuredCompact.mode === "measured_compact" && input.gatewayTransformations.mode === "envelope",
    },
  };
}
