import { Command } from "clipanion";
import { stopRuntime, RuntimeError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class RuntimeStopCommand extends Command<CliContext> {
  static override paths = [["runtime", "stop"]];

  static override usage = Command.Usage({
    category: "Runtime",
    description: "Stop a running Tierkit runtime daemon",
    examples: [["Stop the local daemon", "tierkit runtime stop"]],
  });

  override async execute(): Promise<number> {
    try {
      const r = await stopRuntime({ cwd: this.context.cwd });
      if (r.stopped) {
        this.context.stdout.write(`Sent SIGTERM to pid ${r.pid}\n`);
        return 0;
      }
      this.context.stdout.write(`Not running${r.pid ? ` (pid ${r.pid})` : ""}: ${r.reason}\n`);
      return r.reason ? 1 : 0;
    } catch (err) {
      if (err instanceof RuntimeError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
