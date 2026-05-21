import { Command, Option } from "clipanion";
import { rejectPatchTicket, InvalidPatchStateError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class McpPatchRejectCommand extends Command<CliContext> {
  static override paths = [["mcp", "patch", "reject"]];
  static override usage = Command.Usage({
    description: "Reject an MCP patch ticket; subsequent apply_patch returns approval-rejected",
    examples: [
      ["Reject a patch", "tierkit mcp patch reject patch_abc123 --workspace /path/to/project"],
      ["Reject with a reason", "tierkit mcp patch reject patch_abc123 --workspace /path/to/project --note 'too risky'"],
    ],
  });

  patchId = Option.String();
  workspace = Option.String("--workspace", { required: true });
  note = Option.String("--note");

  override async execute(): Promise<number> {
    try {
      await rejectPatchTicket(this.workspace, this.patchId, "cli", this.note ?? null);
    } catch (err) {
      if (err instanceof InvalidPatchStateError) {
        this.context.stderr.write(`${err.message}\n`);
        return 1;
      }
      throw err;
    }
    this.context.stdout.write(`rejected ${this.patchId}\n`);
    return 0;
  }
}
