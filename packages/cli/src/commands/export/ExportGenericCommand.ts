import { Command, Option } from "clipanion";
import { exportTarget } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatExportResult } from "../../output/printExportResult.js";

export class ExportGenericCommand extends Command<CliContext> {
  static override paths = [["export", "generic"]];

  static override usage = Command.Usage({
    category: "Export",
    description: "Export installed plugins as tool-neutral markdown",
    examples: [
      ["Export to default ./dist/tierkit", "tierkit export generic"],
      ["Export to custom directory", "tierkit export generic --out ./build/plugins"],
    ],
  });

  out = Option.String("--out", "dist/tierkit", {
    description: "Output directory (relative paths resolve against project root)",
  });

  override async execute(): Promise<number> {
    const result = await exportTarget({
      cwd: this.context.cwd,
      target: "generic",
      outDir: this.out,
    });
    this.context.stdout.write(formatExportResult(result) + "\n");
    return result.warnings.length > 0 && result.files.length === 0 ? 1 : 0;
  }
}
