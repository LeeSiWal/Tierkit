import { Command, Option } from "clipanion";
import { installPlugin, PluginInstallError } from "@tierkit/core";
import { PluginLoadError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatIssues } from "../../output/printIssues.js";

export class PluginInstallCommand extends Command<CliContext> {
  static override paths = [["plugin", "install"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Install a plugin from a local directory into the current Tierkit project",
    examples: [
      ["Install local plugin", "tierkit plugin install ./my-plugin"],
      ["Overwrite existing", "tierkit plugin install ./my-plugin --force"],
    ],
  });

  pluginPath = Option.String({ required: true });
  force = Option.Boolean("--force", false, {
    description: "Replace any existing installation with the same plugin id",
  });

  override async execute(): Promise<number> {
    try {
      const result = await installPlugin({
        cwd: this.context.cwd,
        pluginPath: this.pluginPath,
        force: this.force,
      });
      const verb = result.replacedPrevious ? "replaced" : "installed";
      this.context.stdout.write(
        `${verb} ${result.pluginId}@${result.version} → ${result.installedPath}\n`,
      );
      return 0;
    } catch (err) {
      if (err instanceof PluginLoadError) {
        this.context.stderr.write(`failed to load plugin from ${err.pluginDir}\n`);
        this.context.stderr.write(formatIssues(err.issues) + "\n");
        return 1;
      }
      if (err instanceof PluginInstallError) {
        this.context.stderr.write(`install failed: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
