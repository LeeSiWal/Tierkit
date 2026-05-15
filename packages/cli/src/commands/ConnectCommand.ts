import { Command, Option } from "clipanion";
import { connectTool } from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";

const TOOLS = ["roo", "cline", "continue"] as const;
type Tool = (typeof TOOLS)[number];

export class ConnectCommand extends Command<CliContext> {
  static override paths = [["connect"]];

  static override usage = Command.Usage({
    category: "Connect",
    description:
      "Wire an existing coding agent (Roo Code / Cline / Continue) to route through the Tierkit daemon. " +
      "Edits .vscode/settings.json (Roo, Cline) or .continue/config.yaml (Continue) so all that tool's model calls go through Tierkit's policy stack.",
    examples: [
      ["Connect Roo Code, auto-routing", "tierkit connect roo"],
      ["Connect Cline with a specific default profile", "tierkit connect cline --default claudeSonnet"],
      ["Connect Continue", "tierkit connect continue"],
    ],
  });

  tool = Option.String({ required: true });
  defaultProfile = Option.String("--default", "auto", { description: "Default profile id the tool will use as `model` (or `auto` to let Tierkit route)" });
  tierkitBaseUrl = Option.String("--base", { description: "Override Tierkit daemon URL (default http://127.0.0.1:4101)" });

  override async execute(): Promise<number> {
    if (!TOOLS.includes(this.tool as Tool)) {
      this.context.stderr.write(`unknown tool "${this.tool}". Available: ${TOOLS.join(", ")}\n`);
      return 1;
    }
    const r = await connectTool({
      cwd: this.context.cwd,
      tool: this.tool as Tool,
      defaultProfile: this.defaultProfile,
      ...(this.tierkitBaseUrl ? { tierkitBaseUrl: this.tierkitBaseUrl } : {}),
    });
    this.context.stdout.write(`✓ ${r.summary}\n`);
    this.context.stdout.write(`  → ${r.configPath}\n`);
    if (r.followUp) this.context.stdout.write(`\n${r.followUp}\n`);
    return 0;
  }
}
