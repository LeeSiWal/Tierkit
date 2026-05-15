import { Command, Option } from "clipanion";
import { checkCommand } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatCommandCheck } from "../../output/printCheckResults.js";

export class CheckCommandCommand extends Command<CliContext> {
  static override paths = [["check", "command"]];

  static override usage = Command.Usage({
    category: "Check",
    description: "Classify a shell command as ok / warn / block using the dangerous-command rules",
    examples: [
      ['Harmless lookup', 'tierkit check command "ls -la"'],
      ['Block: rm -rf /', 'tierkit check command "rm -rf /"'],
      ['Warn: git reset --hard', 'tierkit check command "git reset --hard origin/main"'],
    ],
  });

  command = Option.String({ required: true });

  override async execute(): Promise<number> {
    const r = await checkCommand({ command: this.command });
    this.context.stdout.write(formatCommandCheck(r) + "\n");
    return r.severity === "block" ? 2 : r.severity === "warn" ? 1 : 0;
  }
}
