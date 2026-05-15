import { Command, Option } from "clipanion";
import { explainRouteUsecase } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { formatRouteDecision } from "../../output/printRouteDecision.js";

export class RouteExplainCommand extends Command<CliContext> {
  static override paths = [["route", "explain"]];

  static override usage = Command.Usage({
    category: "Routing",
    description: "Explain which model tier and profile Tierkit would choose for a task",
    examples: [
      ['Trivial task', 'tierkit route explain "rename a helper function"'],
      ['High-risk task', 'tierkit route explain "rotate production secrets" --secrets --prod'],
    ],
  });

  task = Option.String({ required: true });
  filesEstimate = Option.String("--files", { description: "Estimated number of files touched" });
  secrets = Option.Boolean("--secrets", false, { description: "Task involves secrets" });
  prod = Option.Boolean("--prod", false, { description: "Task involves production infrastructure" });

  override async execute(): Promise<number> {
    const result = await explainRouteUsecase({
      cwd: this.context.cwd,
      task: this.task,
      ...(this.filesEstimate !== undefined
        ? { filesTouchedEstimate: Number.parseInt(this.filesEstimate, 10) }
        : {}),
      involvesSecrets: this.secrets,
      involvesProductionInfra: this.prod,
    });
    this.context.stdout.write(formatRouteDecision(result) + "\n");
    return 0;
  }
}
