import { Command, Option } from "clipanion";
import { syncPlugins, detectConnectedTools, type ConnectableTool } from "@tierkit/core";
import { RooAdapter } from "@tierkit/adapter-roo";
import { ClineAdapter } from "@tierkit/adapter-cline";
import { ContinueAdapter } from "@tierkit/adapter-continue";
import type { CliContext } from "../../context/CliContext.js";

export class PluginSyncCommand extends Command<CliContext> {
  static override paths = [["plugin", "sync"]];

  static override usage = Command.Usage({
    category: "Plugin",
    description:
      "Re-export active Tierkit plugins to every connected coding agent " +
      "(Roo / Cline / Continue detected via filesystem signals). " +
      "Runs automatically on plugin enable/disable; this command exists for explicit re-syncs.",
    examples: [
      ["Sync to all detected tools", "tierkit plugin sync"],
      ["Force-sync to specific tools regardless of detection", "tierkit plugin sync --tool roo --tool cline"],
    ],
  });

  tool = Option.Array("--tool", { description: "Force-include specific tool(s); skips detection" });

  override async execute(): Promise<number> {
    const adapters = {
      roo: new RooAdapter(),
      cline: new ClineAdapter(),
      continue: new ContinueAdapter(),
    } as const;

    const detected = await detectConnectedTools(this.context.cwd);
    this.context.stdout.write(`detected: ${detected.length ? detected.join(", ") : "(none)"}\n`);

    const r = await syncPlugins({
      cwd: this.context.cwd,
      adapters,
      ...(this.tool && this.tool.length > 0
        ? { tools: this.tool.filter((t): t is ConnectableTool => t === "roo" || t === "cline" || t === "continue") }
        : {}),
    });

    for (const s of r.synced) {
      this.context.stdout.write(`✓ ${s.tool} — ${s.filesWritten} files${s.warnings > 0 ? ` (${s.warnings} warnings)` : ""}\n`);
    }
    for (const sk of r.skipped) {
      this.context.stdout.write(`- ${sk.tool} skipped: ${sk.reason}\n`);
    }
    if (r.synced.length === 0 && r.skipped.length === 0) {
      this.context.stdout.write("no tools detected. Run `tierkit connect <tool>` first.\n");
    }
    return 0;
  }
}
