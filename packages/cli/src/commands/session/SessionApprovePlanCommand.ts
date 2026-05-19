import { Command } from "clipanion";
import { approvePlan, SessionError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class SessionApprovePlanCommand extends Command<CliContext> {
  static override paths = [["session", "approve-plan"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Mark the plan approved on the current session (required by strict freedom for mode=execute)",
    examples: [["Approve current plan", "tierkit session approve-plan"]],
  });

  override async execute(): Promise<number> {
    try {
      const s = await approvePlan({ cwd: this.context.cwd });
      this.context.stdout.write(`session ${s.id} — plan approved\n`);
      return 0;
    } catch (err) {
      if (err instanceof SessionError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
