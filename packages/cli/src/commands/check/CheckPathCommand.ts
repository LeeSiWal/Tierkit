import { Command, Option } from "clipanion";
import { checkPath } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatPathCheck } from "../../output/printCheckResults.js";

export class CheckPathCommand extends Command<CliContext> {
  static override paths = [["check", "path"]];

  static override usage = Command.Usage({
    category: "Check",
    description: "Check whether a file path matches the sensitive-file blocklist",
    examples: [
      ["Check a config path", "tierkit check path .env"],
      ["Check a key path", "tierkit check path home/me/.ssh/id_rsa"],
    ],
  });

  pathToCheck = Option.String({ required: true });

  override async execute(): Promise<number> {
    const r = await checkPath({ pathToCheck: this.pathToCheck });
    this.context.stdout.write(formatPathCheck(r) + "\n");
    return r.sensitive ? 1 : 0;
  }
}
