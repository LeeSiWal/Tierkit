import { Command, Option } from "clipanion";
import { enablePlugin, PluginLifecycleError } from "@tierkit/core";
import { RooAdapter } from "@tierkit/adapter-roo";
import { ClineAdapter } from "@tierkit/adapter-cline";
import { ContinueAdapter } from "@tierkit/adapter-continue";
import type { CliContext } from "../../context/CliContext.js";

export class PluginEnableCommand extends Command<CliContext> {
  static override paths = [["plugin", "enable"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Add a plugin id to tierkit.config.json::activePlugins",
    examples: [["Enable an installed plugin", "tierkit plugin enable superpowers-free"]],
  });

  pluginId = Option.String({ required: true });

  override async execute(): Promise<number> {
    try {
      const r = await enablePlugin({
        cwd: this.context.cwd,
        pluginId: this.pluginId,
        adapters: {
          roo: new RooAdapter(),
          cline: new ClineAdapter(),
          continue: new ContinueAdapter(),
        },
      });
      this.context.stdout.write(`enabled ${r.pluginId}\n`);
      this.context.stdout.write(`activePlugins: [${r.activePlugins.join(", ")}]\n`);
      if (r.sync) {
        for (const s of r.sync.synced) {
          this.context.stdout.write(`  → ${s.tool}: ${s.filesWritten} files synced\n`);
        }
      }
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
