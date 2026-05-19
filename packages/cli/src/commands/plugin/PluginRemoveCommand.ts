import { Command, Option } from "clipanion";
import { removePlugin, PluginLifecycleError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class PluginRemoveCommand extends Command<CliContext> {
  static override paths = [["plugin", "remove"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Uninstall a plugin: delete its files and remove from registry + activePlugins",
    examples: [["Remove an installed plugin", "tierkit plugin remove superpowers-free"]],
  });

  pluginId = Option.String({ required: true });

  override async execute(): Promise<number> {
    try {
      const r = await removePlugin({ cwd: this.context.cwd, pluginId: this.pluginId });
      this.context.stdout.write(`removed ${r.pluginId}\n`);
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
