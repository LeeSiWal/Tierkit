import { Command, Option } from "clipanion";
import { usage } from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";
import { formatUsage } from "../output/printUsage.js";

export class UsageCommand extends Command<CliContext> {
  static override paths = [["usage"]];

  static override usage = Command.Usage({
    category: "Savings",
    description: "Summarize runtime usage log (calls / tokens / cost per profile)",
    examples: [
      ["All-time totals", "tierkit usage"],
      ["Since a date", "tierkit usage --since 2026-05-01"],
    ],
  });

  since = Option.String("--since", { description: "ISO date — only summarize records on or after this." });

  override async execute(): Promise<number> {
    const r = await usage({
      cwd: this.context.cwd,
      ...(this.since !== undefined ? { since: new Date(this.since) } : {}),
    });
    this.context.stdout.write(formatUsage(r) + "\n");
    return 0;
  }
}
