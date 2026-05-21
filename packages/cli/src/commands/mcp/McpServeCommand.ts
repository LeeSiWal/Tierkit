import { Command, Option } from "clipanion";
import path from "node:path";
import type { CliContext } from "../../context/CliContext.js";

/**
 * `tierkit mcp serve --workspace <path>`
 *
 * Runs an MCP server over stdio. Spawned by an MCP-aware client
 * (Claude Code, Claude Desktop) via their `mcpServers` config.
 * Stdout is reserved for MCP JSON-RPC framing; logs go to stderr.
 */
export class McpServeCommand extends Command<CliContext> {
  static override paths = [["mcp", "serve"]];
  static override usage = Command.Usage({
    description: "Run the Tierkit MCP server over stdio",
    examples: [["Serve for /Users/me/project", "tierkit mcp serve --workspace /Users/me/project"]],
  });

  workspace = Option.String("--workspace", { required: true });

  override async execute(): Promise<number> {
    const abs = path.resolve(this.workspace);
    process.stderr.write(`[tierkit mcp serve] workspace=${abs}\n`);
    const { runMcpStdio } = await import("@tierkit/mcp-server");
    await runMcpStdio({ workspaceRoot: abs, env: process.env });
    return 0;
  }
}
