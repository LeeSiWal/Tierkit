import { Command } from "clipanion";
import { listModels } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatModelList } from "../../output/printModelList.js";

export class ModelsListCommand extends Command<CliContext> {
  static override paths = [["models", "list"]];

  static override usage = Command.Usage({
    category: "Models",
    description: "List model profiles declared in tierkit.config.json",
    examples: [["List configured model profiles", "tierkit models list"]],
  });

  override async execute(): Promise<number> {
    const result = await listModels({ cwd: this.context.cwd });
    this.context.stdout.write(formatModelList(result) + "\n");
    return 0;
  }
}
