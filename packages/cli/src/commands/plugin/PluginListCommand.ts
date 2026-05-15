import { Command } from "clipanion";
import { listPlugins } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatPluginList } from "../../output/printPluginList.js";

export class PluginListCommand extends Command<CliContext> {
  static override paths = [["plugin", "list"]];

  static override usage = Command.Usage({
    category: "Plugin",
    description: "List plugins installed in the current Tierkit project",
    examples: [["List installed plugins", "tierkit plugin list"]],
  });

  override async execute(): Promise<number> {
    const result = await listPlugins({ cwd: this.context.cwd });
    this.context.stdout.write(formatPluginList(result.plugins) + "\n");
    return 0;
  }
}
