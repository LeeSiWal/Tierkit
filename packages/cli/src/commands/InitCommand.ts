import { Command, Option } from "clipanion";
import { initProject, TARGETS, type Target } from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";

export class InitCommand extends Command<CliContext> {
  static override paths = [["init"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Initialize a Tierkit project in the current directory",
    examples: [
      ["Initialize with default target", "tierkit init"],
      ["Initialize for Roo Code", "tierkit init --target roo"],
    ],
  });

  target = Option.String("--target", "generic", {
    description: `Default adapter target (one of: ${TARGETS.join(", ")})`,
  });

  force = Option.Boolean("--force", false, {
    description: "Overwrite existing tierkit.config.json and registry",
  });

  override async execute(): Promise<number> {
    if (!(TARGETS as readonly string[]).includes(this.target)) {
      this.context.stderr.write(
        `Invalid --target "${this.target}". Allowed: ${TARGETS.join(", ")}\n`,
      );
      return 1;
    }
    const result = await initProject({
      cwd: this.context.cwd,
      defaultTarget: this.target as Target,
      force: this.force,
    });

    if (result.created.length > 0) {
      for (const f of result.created) this.context.stdout.write(`created  ${f}\n`);
    }
    if (result.skipped.length > 0) {
      for (const f of result.skipped) this.context.stdout.write(`skipped  ${f} (already exists)\n`);
    }
    this.context.stdout.write(`Tierkit project initialized at ${result.projectRoot}\n`);
    return 0;
  }
}
