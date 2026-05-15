import { Command, Option } from "clipanion";
import { startSession } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class SessionStartCommand extends Command<CliContext> {
  static override paths = [["session", "start"]];

  static override usage = Command.Usage({
    category: "Session",
    description: "Start a workflow session for a task (state=planning)",
    examples: [['Start a session', 'tierkit session start "refactor auth middleware"']],
  });

  task = Option.String({ required: true });

  override async execute(): Promise<number> {
    const r = await startSession({ cwd: this.context.cwd, task: this.task });
    if (r.replacedPrevious) {
      this.context.stdout.write(`abandoned previous session\n`);
    }
    this.context.stdout.write(`session ${r.session.id} started\n`);
    this.context.stdout.write(`  task     ${r.session.task}\n`);
    this.context.stdout.write(`  state    ${r.session.state}\n`);
    this.context.stdout.write(`  freedom  ${r.session.freedom}\n`);
    return 0;
  }
}
