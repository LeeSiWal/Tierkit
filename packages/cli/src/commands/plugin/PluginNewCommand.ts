import { Command, Option } from "clipanion";
import { pluginNew, PluginNewError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class PluginNewCommand extends Command<CliContext> {
  static override paths = [["plugin", "new"]];

  static override usage = Command.Usage({
    category: "Plugin",
    description:
      "Scaffold a new Tierkit plugin directory with manifest + one sample command + one sample mode + one sample rule. " +
      "After editing, run `tierkit plugin install <dir>` then `tierkit plugin enable <id>`.",
    examples: [
      ["Scaffold 'my-plugin' in current directory", "tierkit plugin new my-plugin"],
      ["Scaffold with custom name + author", "tierkit plugin new code-review --name 'Code Review' --author alice"],
    ],
  });

  id = Option.String({ required: true });
  name = Option.String("--name", { description: "Human-readable plugin name (defaults to title-cased id)" });
  description = Option.String("--description", { description: "One-line description" });
  author = Option.String("--author", { description: "Author string" });
  force = Option.Boolean("--force", false, { description: "Overwrite existing directory" });

  override async execute(): Promise<number> {
    try {
      const r = await pluginNew({
        cwd: this.context.cwd,
        id: this.id,
        ...(this.name ? { name: this.name } : {}),
        ...(this.description ? { description: this.description } : {}),
        ...(this.author ? { author: this.author } : {}),
        force: this.force,
      });
      this.context.stdout.write(`created plugin "${this.id}" at ${r.pluginDir}\n`);
      for (const f of r.created) this.context.stdout.write(`  + ${f}\n`);
      for (const f of r.skipped) this.context.stdout.write(`  - ${f} (skipped, already exists)\n`);
      this.context.stdout.write(
        `\nNext: edit ${r.pluginDir}/tierkit.plugin.json, then:\n` +
          `  tierkit plugin install ${r.pluginDir}\n` +
          `  tierkit plugin enable ${this.id}\n` +
          `  tierkit plugin sync   # propagate to Roo/Cline/Continue\n`,
      );
      return 0;
    } catch (err) {
      if (err instanceof PluginNewError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
