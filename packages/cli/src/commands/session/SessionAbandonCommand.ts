import { Command, Option } from "clipanion";
import { abandonSession } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class SessionAbandonCommand extends Command<CliContext> {
  static override paths = [["session", "abandon"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Abandon the current session (no further runs against it).",
    examples: [["Abandon current", "tierkit session abandon"]],
  });

  reason = Option.String("--reason", { description: "Reason recorded in history." });

  override async execute(): Promise<number> {
    const s = await abandonSession({
      cwd: this.context.cwd,
      ...(this.reason ? { reason: this.reason } : {}),
    });
    if (!s) {
      this.context.stdout.write(`no current session to abandon\n`);
      return 0;
    }
    this.context.stdout.write(`session ${s.id} abandoned\n`);
    return 0;
  }
}
