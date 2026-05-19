import { Command } from "clipanion";
import { runtimeStatus } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class RuntimeStatusCommand extends Command<CliContext> {
  static override paths = [["runtime", "status"]];

  static override usage = Command.Usage({
    category: "Diagnostics",
    description: "Show whether the runtime daemon is running and reachable",
    examples: [["Check status", "tierkit runtime status"]],
  });

  override async execute(): Promise<number> {
    const r = await runtimeStatus({ cwd: this.context.cwd });
    if (!r.running) {
      this.context.stdout.write(`runtime: NOT RUNNING${r.reason ? ` (${r.reason})` : ""}\n`);
      return 1;
    }
    this.context.stdout.write(`runtime: RUNNING\n`);
    this.context.stdout.write(`  pid       ${r.pid}\n`);
    if (r.port) this.context.stdout.write(`  port      ${r.port}\n`);
    if (r.baseUrl) this.context.stdout.write(`  base url  ${r.baseUrl}\n`);
    if (r.health) {
      this.context.stdout.write(`  health    ${JSON.stringify(r.health)}\n`);
    } else {
      this.context.stdout.write(`  health    (unreachable — pid is alive but /v1/health did not respond)\n`);
    }
    return 0;
  }
}
