import { Command, Option } from "clipanion";
import { exportTarget } from "@tierkit/core";
import { RooAdapter } from "@tierkit/adapter-roo";
import type { CliContext } from "../../context/CliContext.js";
import { formatExportResult } from "../../output/printExportResult.js";

export class ExportRooCommand extends Command<CliContext> {
  static override paths = [
    ["export", "roo"],
    ["export", "zoo"],
  ];

  static override usage = Command.Usage({
    category: "Integrations",
    description: "Export installed plugins for Roo Code / Zoo Code (.roomodes + .roo/)",
    examples: [
      ["Export at project root (default)", "tierkit export roo"],
      ["Export to a different directory", "tierkit export roo --out ./build/roo"],
    ],
  });

  out = Option.String("--out", ".", {
    description:
      "Output directory. Defaults to the project root, where Roo expects .roomodes and .roo/.",
  });

  override async execute(): Promise<number> {
    const result = await exportTarget({
      cwd: this.context.cwd,
      target: "roo",
      outDir: this.out,
      adapters: { roo: new RooAdapter() },
    });
    this.context.stdout.write(formatExportResult(result) + "\n");
    return result.warnings.length > 0 && result.files.length === 0 ? 1 : 0;
  }
}
