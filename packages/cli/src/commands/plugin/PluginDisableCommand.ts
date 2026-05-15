import { Command, Option } from "clipanion";
import { disablePlugin, PluginLifecycleError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class PluginDisableCommand extends Command<CliContext> {
  static override paths = [["plugin", "disable"]];

  static override usage = Command.Usage({
    category: "Plugin",
    description: "Remove a plugin id from tierkit.config.json::activePlugins (keeps it installed)",
    examples: [["Disable an active plugin", "tierkit plugin disable superpowers-free"]],
  });

  pluginId = Option.String({ required: true });

  override async execute(): Promise<number> {
    try {
      const r = await disablePlugin({ cwd: this.context.cwd, pluginId: this.pluginId });
      this.context.stdout.write(`disabled ${r.pluginId}\n`);
      this.context.stdout.write(`activePlugins: [${r.activePlugins.join(", ")}]\n`);
      return 0;
    } catch (err) {
      if (err instanceof PluginLifecycleError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
