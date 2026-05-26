/**
 * Pure helpers for reading and mutating the `runtime.gatewayMode` field in a
 * Tierkit config object. Used by the offline file-fallback toggle path.
 *
 * Pure. NO `vscode` import. Unit-testable without the VS Code runtime.
 */
export type GatewayMode = "off" | "on";

export function readGatewayModeFromConfig(config: Record<string, unknown>): GatewayMode {
  const runtime =
    config.runtime && typeof config.runtime === "object"
      ? (config.runtime as Record<string, unknown>)
      : {};
  const value = runtime.gatewayMode;
  if (value === undefined) return "off";
  if (value === "off" || value === "on") return value;
  throw new Error("runtime.gatewayMode has an invalid value");
}

export function withGatewayMode(config: Record<string, unknown>, next: GatewayMode): Record<string, unknown> {
  const runtime =
    config.runtime && typeof config.runtime === "object"
      ? { ...(config.runtime as Record<string, unknown>) }
      : {};
  runtime.gatewayMode = next;
  return { ...config, runtime };
}
