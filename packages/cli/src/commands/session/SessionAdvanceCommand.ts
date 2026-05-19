import { Command, Option } from "clipanion";
import { advanceSession, SessionError, SESSION_STATES, type SessionState } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class SessionAdvanceCommand extends Command<CliContext> {
  static override paths = [["session", "advance"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Advance the current session to a new state",
    examples: [
      ["Move to implementing", "tierkit session advance implementing"],
      ["Move to reviewing", "tierkit session advance reviewing"],
      ["Mark done", "tierkit session advance done"],
    ],
  });

  toState = Option.String({ required: true });
  reason = Option.String("--reason", { description: "Optional reason recorded in session history." });

  override async execute(): Promise<number> {
    if (!(SESSION_STATES as readonly string[]).includes(this.toState)) {
      this.context.stderr.write(`invalid state "${this.toState}". Allowed: ${SESSION_STATES.join(", ")}\n`);
      return 1;
    }
    try {
      const s = await advanceSession({
        cwd: this.context.cwd,
        toState: this.toState as SessionState,
        ...(this.reason ? { reason: this.reason } : {}),
      });
      this.context.stdout.write(`session ${s.id} → ${s.state}\n`);
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
