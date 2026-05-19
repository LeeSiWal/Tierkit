import { Command, Option } from "clipanion";
import { showConfig } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatConfig } from "../../output/printConfig.js";

export class ConfigShowCommand extends Command<CliContext> {
  static override paths = [["config", "show"]];

  static override usage = Command.Usage({
    category: "Cost routing",
    description: "Print the loaded tierkit.config.json (env-var values masked by default)",
    examples: [
      ["Show config with API keys masked", "tierkit config show"],
      ["Show config and reveal env var values (USE WITH CARE)", "tierkit config show --reveal-env"],
    ],
  });

  revealEnv = Option.Boolean("--reveal-env", false, {
    description:
      "Reveal the resolved values of apiKeyEnv variables. By default they are masked.",
  });

  override async execute(): Promise<number> {
    const result = await showConfig({ cwd: this.context.cwd, revealEnvValues: this.revealEnv });
    this.context.stdout.write(formatConfig(result, this.revealEnv) + "\n");
    return result.configFound ? 0 : 1;
  }
}
