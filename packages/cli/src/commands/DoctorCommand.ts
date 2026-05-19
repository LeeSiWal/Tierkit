import { Command } from "clipanion";
import { doctor } from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";

export class DoctorCommand extends Command<CliContext> {
  static override paths = [["doctor"]];

  static override usage = Command.Usage({
    category: "Diagnostics",
    description: "Diagnose the current Tierkit project",
    examples: [["Run diagnostics", "tierkit doctor"]],
  });

  override async execute(): Promise<number> {
    const result = await doctor({ cwd: this.context.cwd });
    this.context.stdout.write(`Tierkit doctor — ${result.projectRoot}\n`);
    for (const c of result.checks) {
      const tag = c.status === "ok" ? "OK  " : c.status === "warn" ? "WARN" : "FAIL";
      const detail = c.detail ? ` — ${c.detail}` : "";
      this.context.stdout.write(`  [${tag}] ${c.label}${detail}\n`);
    }
    this.context.stdout.write(`\nOverall: ${result.status.toUpperCase()}\n`);
    return result.status === "fail" ? 1 : 0;
  }
}
