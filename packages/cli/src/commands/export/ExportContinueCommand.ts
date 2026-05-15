import { Command, Option } from "clipanion";
import { exportTarget } from "@tierkit/core";
import { ContinueAdapter } from "@tierkit/adapter-continue";
import type { CliContext } from "../../context/CliContext.js";
import { formatExportResult } from "../../output/printExportResult.js";

export class ExportContinueCommand extends Command<CliContext> {
  static override paths = [["export", "continue"]];

  static override usage = Command.Usage({
    category: "Export",
    description: "Export installed plugins for Continue (.continue/{config.yaml, rules, prompts, mcp})",
    examples: [
      ["Export at project root (default)", "tierkit export continue"],
      ["Export to a different directory", "tierkit export continue --out ./build/continue"],
    ],
  });

  out = Option.String("--out", ".", {
    description:
      "Output directory. Defaults to the project root, where Continue expects .continue/.",
  });

  override async execute(): Promise<number> {
    const result = await exportTarget({
      cwd: this.context.cwd,
      target: "continue",
      outDir: this.out,
      adapters: { continue: new ContinueAdapter() },
    });
    this.context.stdout.write(formatExportResult(result) + "\n");
    return result.warnings.length > 0 && result.files.length === 0 ? 1 : 0;
  }
}
