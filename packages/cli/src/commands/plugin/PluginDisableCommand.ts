import { Command, Option } from "clipanion";
import { disablePlugin, PluginLifecycleError } from "@tierkit/core";
import { RooAdapter } from "@tierkit/adapter-roo";
import { ClineAdapter } from "@tierkit/adapter-cline";
import { ContinueAdapter } from "@tierkit/adapter-continue";
import type { CliContext } from "../../context/CliContext.js";

export class PluginDisableCommand extends Command<CliContext> {
  static override paths = [["plugin", "disable"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Remove a plugin id from tierkit.config.json::activePlugins (keeps it installed)",
    examples: [["Disable an active plugin", "tierkit plugin disable superpowers-free"]],
  });

  pluginId = Option.String({ required: true });

  override async execute(): Promise<number> {
    try {
      const r = await disablePlugin({
        cwd: this.context.cwd,
        pluginId: this.pluginId,
        adapters: {
          roo: new RooAdapter(),
          cline: new ClineAdapter(),
          continue: new ContinueAdapter(),
        },
      });
      this.context.stdout.write(`disabled ${r.pluginId}\n`);
      this.context.stdout.write(`activePlugins: [${r.activePlugins.join(", ")}]\n`);
      if (r.sync) {
        for (const s of r.sync.synced) this.context.stdout.write(`  → ${s.tool}: ${s.filesWritten} files synced\n`);
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
