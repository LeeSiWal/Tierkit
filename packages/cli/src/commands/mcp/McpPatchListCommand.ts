import { Command, Option } from "clipanion";
import { listPatchTickets } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class McpPatchListCommand extends Command<CliContext> {
  static override paths = [["mcp", "patch", "list"]];
  static override usage = Command.Usage({
    description: "List pending MCP patch tickets in a workspace",
    examples: [
      ["List all patches for a workspace", "tierkit mcp patch list --workspace /path/to/project"],
    ],
  });

  workspace = Option.String("--workspace", { required: true });

  override async execute(): Promise<number> {
    const tickets = await listPatchTickets(this.workspace);
    this.context.stdout.write(JSON.stringify(tickets, null, 2) + "\n");
    return 0;
  }
}
