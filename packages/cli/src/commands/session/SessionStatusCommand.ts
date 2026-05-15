import { Command } from "clipanion";
import { getCurrentSession } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class SessionStatusCommand extends Command<CliContext> {
  static override paths = [["session", "status"]];

  static override usage = Command.Usage({
    category: "Session",
    description: "Show the current workflow session (if any) and effective freedom level",
    examples: [["Check session", "tierkit session status"]],
  });

  override async execute(): Promise<number> {
    const r = await getCurrentSession({ cwd: this.context.cwd });
    this.context.stdout.write(`effective freedom: ${r.freedom}\n`);
    if (!r.session) {
      this.context.stdout.write(`current session: NONE\n`);
      if (r.freedom !== "free") {
        this.context.stdout.write(
          `\nfreedom level "${r.freedom}" requires a session. Start one with:\n  tierkit session start "<task>"\n`,
        );
      }
      return 0;
    }
    const s = r.session;
    this.context.stdout.write(`current session: ${s.id}\n`);
    this.context.stdout.write(`  task            ${s.task}\n`);
    this.context.stdout.write(`  state           ${s.state}\n`);
    this.context.stdout.write(`  plan approved   ${s.planApproved ? "yes" : "no"}\n`);
    this.context.stdout.write(`  review approved ${s.reviewApproved ? "yes" : "no"}\n`);
    this.context.stdout.write(`  freedom         ${s.freedom}\n`);
    this.context.stdout.write(`  created         ${s.createdAt}\n`);
    this.context.stdout.write(`  history (${s.history.length} event${s.history.length === 1 ? "" : "s"}):\n`);
    for (const h of s.history) {
      const from = h.from ?? "—";
      this.context.stdout.write(`    ${h.timestamp}  ${from} → ${h.to}${h.reason ? ` (${h.reason})` : ""}\n`);
    }
    return 0;
  }
}
