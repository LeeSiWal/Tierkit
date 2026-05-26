const ALLOWED = new Set<string>([
  "tierkit.toggleGatewayMode",
  "tierkit.launchClaudeCodeWithGateway",
]);

export function isAllowedWebviewCommand(command: unknown): command is string {
  return typeof command === "string" && ALLOWED.has(command);
}
