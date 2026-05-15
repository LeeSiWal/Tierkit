import { Command, Option } from "clipanion";
import { enablePlugin, PluginLifecycleError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class PluginEnableCommand extends Command<CliContext> {
  static override paths = [["plugin", "enable"]];

  static override usage = Command.Usage({
    category: "Plugin",
    description: "Add a plugin id to tierkit.config.json::activePlugins",
    examples: [["Enable an installed plugin", "tierkit plugin enable superpowers-free"]],
  });

  pluginId = Option.String({ required: true });

  override async execute(): Promise<number> {
    try {
      const r = await enablePlugin({ cwd: this.context.cwd, pluginId: this.pluginId });
      this.context.stdout.write(`enabled ${r.pluginId}\n`);
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
