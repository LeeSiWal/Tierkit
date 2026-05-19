import { Command, Option } from "clipanion";
import { exportTarget } from "@tierkit/core";
import { ClineAdapter } from "@tierkit/adapter-cline";
import type { CliContext } from "../../context/CliContext.js";
import { formatExportResult } from "../../output/printExportResult.js";

export class ExportClineCommand extends Command<CliContext> {
  static override paths = [["export", "cline"]];

  static override usage = Command.Usage({
    category: "Integrations",
    description: "Export installed plugins for Cline (.clinerules/ + .cline/mcp/)",
    examples: [
      ["Export at project root (default)", "tierkit export cline"],
      ["Export to a different directory", "tierkit export cline --out ./build/cline"],
    ],
  });

  out = Option.String("--out", ".", {
    description:
      "Output directory. Defaults to the project root, where Cline expects .clinerules/.",
  });

  override async execute(): Promise<number> {
    const result = await exportTarget({
      cwd: this.context.cwd,
      target: "cline",
      outDir: this.out,
      adapters: { cline: new ClineAdapter() },
    });
    this.context.stdout.write(formatExportResult(result) + "\n");
    return result.warnings.length > 0 && result.files.length === 0 ? 1 : 0;
  }
}
