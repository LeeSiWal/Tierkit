import { Command, Option } from "clipanion";
import { testModel, TestModelError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatProbeResult } from "../../output/printProbeResult.js";

export class ModelsTestCommand extends Command<CliContext> {
  static override paths = [["models", "test"]];

  static override usage = Command.Usage({
    category: "Cost routing",
    description: "Probe a configured model profile to verify reachability and credentials",
    examples: [
      ["Probe a local Ollama profile", "tierkit models test localFast"],
      ["Probe a private remote profile", "tierkit models test privateRemoteStrong"],
    ],
  });

  profileId = Option.String({ required: true });

  override async execute(): Promise<number> {
    try {
      const result = await testModel({ cwd: this.context.cwd, profileId: this.profileId });
      this.context.stdout.write(formatProbeResult(result) + "\n");
      return result.result.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof TestModelError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
