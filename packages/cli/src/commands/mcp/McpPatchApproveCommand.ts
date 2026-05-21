import { Command, Option } from "clipanion";
import { approvePatchTicket, InvalidPatchStateError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class McpPatchApproveCommand extends Command<CliContext> {
  static override paths = [["mcp", "patch", "approve"]];
  static override usage = Command.Usage({
    description: "Approve an MCP patch ticket so the next apply_patch call succeeds",
    examples: [
      ["Approve a patch", "tierkit mcp patch approve patch_abc123 --workspace /path/to/project"],
      ["Approve with a note", "tierkit mcp patch approve patch_abc123 --workspace /path/to/project --note 'LGTM'"],
    ],
  });

  patchId = Option.String();
  workspace = Option.String("--workspace", { required: true });
  note = Option.String("--note");

  override async execute(): Promise<number> {
    try {
      await approvePatchTicket(this.workspace, this.patchId, "cli", this.note ?? null);
    } catch (err) {
      if (err instanceof InvalidPatchStateError) {
        this.context.stderr.write(`${err.message}\n`);
        return 1;
      }
      throw err;
    }
    this.context.stdout.write(`approved ${this.patchId}\n`);
    return 0;
  }
}
