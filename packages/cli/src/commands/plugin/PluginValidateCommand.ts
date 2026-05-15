import { Command, Option } from "clipanion";
import { validatePlugin } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatIssues } from "../../output/printIssues.js";

export class PluginValidateCommand extends Command<CliContext> {
  static override paths = [["plugin", "validate"]];

  static override usage = Command.Usage({
    category: "Plugin",
    description: "Validate a Tierkit plugin directory",
    examples: [
      ["Validate a plugin", "tierkit plugin validate ./my-plugin"],
      ["Treat warnings as errors", "tierkit plugin validate ./my-plugin --strict"],
    ],
  });

  pluginPath = Option.String({ required: true });
  strict = Option.Boolean("--strict", false, {
    description: "Treat warnings as errors",
  });

  override async execute(): Promise<number> {
    const result = await validatePlugin({
      cwd: this.context.cwd,
      pluginPath: this.pluginPath,
      strict: this.strict,
    });

    if (result.ok) {
      this.context.stdout.write(
        `valid: ${result.manifest.id}@${result.manifest.version}  (${result.pluginPath})\n`,
      );
      if (result.warnings.length > 0) {
        this.context.stdout.write(`Warnings (${result.warnings.length}):\n`);
        this.context.stdout.write(formatIssues(result.warnings) + "\n");
      }
      return 0;
    }

    this.context.stderr.write(`invalid plugin: ${result.pluginPath}\n`);
    this.context.stderr.write(formatIssues(result.issues) + "\n");
    return 1;
  }
}
