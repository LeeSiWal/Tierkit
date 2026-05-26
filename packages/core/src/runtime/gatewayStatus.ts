import { gatewayLogPath } from "./gatewayLog.js";
import type { GatewayTransformationsConfig } from "../config/TierkitConfig.js";

export interface GatewayStatusInput {
  gatewayMode: "off" | "on";
  resolvedDataDir: string;
  gatewayTransformations: GatewayTransformationsConfig;
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
  };
}
