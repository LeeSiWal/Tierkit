import type { ShowConfigResult } from "@tierkit/core";

export function formatConfig(result: ShowConfigResult, revealEnvValues: boolean): string {
  if (!result.configFound) {
    return `No tierkit.config.json found at ${result.projectRoot}. Run \`tierkit init\` first.`;
  }

  // Build a safe view: deep-clone-via-JSON then mask any apiKeyEnv-referenced env values
  // by stripping nothing from the config itself — the config file references env vars, not values.
  // Render config + a separate "secrets" status block.
  const lines: string[] = [`# tierkit config (${result.configPath})`, "", JSON.stringify(result.config, null, 2), ""];

  if (result.apiKeyEnvStatus.length > 0) {
    lines.push("# API key env vars");
    for (const s of result.apiKeyEnvStatus) {
      const valuePart = revealEnvValues
        ? s.value !== undefined
          ? ` = "${s.value}"`
          : " = (not set)"
        : s.present
          ? " = ***"
          : " = (not set)";
      lines.push(`  ${s.envVar}${valuePart}    [used by profile "${s.profileId}"]`);
    }
  }
  return lines.join("\n");
}
