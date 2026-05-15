import { Command, Option } from "clipanion";
import { checkRedact } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatRedactResult } from "../../output/printCheckResults.js";

export class CheckRedactCommand extends Command<CliContext> {
  static override paths = [["check", "redact"]];

  static override usage = Command.Usage({
    category: "Check",
    description: "Run secret redaction over a file and report which rules triggered",
    examples: [
      ["Just show which rules triggered", "tierkit check redact ./scratch/notes.md"],
      ["Print the redacted contents too", "tierkit check redact ./scratch/notes.md --print"],
    ],
  });

  filePath = Option.String({ required: true });
  print = Option.Boolean("--print", false, {
    description: "Also print the redacted file body. Default off to avoid leaking content into the shell.",
  });

  override async execute(): Promise<number> {
    const r = await checkRedact({ cwd: this.context.cwd, filePath: this.filePath });
    this.context.stdout.write(formatRedactResult(r, this.print) + "\n");
    return r.hits.length > 0 ? 1 : 0;
  }
}
