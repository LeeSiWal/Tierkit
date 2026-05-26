export interface GatewayEnvInput {
  baseUrl: string;
  parentEnv: Record<string, string | undefined>;
}

export function buildGatewayEnv(input: GatewayEnvInput): Record<string, string | undefined> {
  return { ...input.parentEnv, ANTHROPIC_BASE_URL: input.baseUrl };
}

export function gatewayLaunchCommand(env: Record<string, string | undefined>): string {
  return env.TIERKIT_CLAUDE_CODE_BIN ?? "claude";
}

export type Readiness =
  | { kind: "ready" }
  | { kind: "mode-off" }
  | { kind: "unreachable" };

export function classifyReadiness(body: { gatewayMode?: "off" | "on"; routesEnabled?: boolean } | null | undefined): Readiness {
  if (!body) return { kind: "unreachable" };
  if (body.gatewayMode === "off") return { kind: "mode-off" };
  if (body.routesEnabled === true) return { kind: "ready" };
  return { kind: "unreachable" };
}

export function nextGatewayMode(current: "off" | "on"): "off" | "on" {
  return current === "on" ? "off" : "on";
}
