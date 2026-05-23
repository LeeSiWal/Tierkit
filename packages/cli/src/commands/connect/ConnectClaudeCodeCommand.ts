import path from "node:path";
import { Command, Option } from "clipanion";
import {
  claudeCodeStatus,
  connectClaudeCode,
  disconnectClaudeCode,
  type ConnectScope,
  type InstructionsLevel,
} from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

const SCOPES: ConnectScope[] = ["global", "workspace"];
const LEVELS: InstructionsLevel[] = ["none", "light", "full"];

export class ConnectClaudeCodeCommand extends Command<CliContext> {
  static override paths = [["connect", "claude-code"]];

  static override usage = Command.Usage({
    category: "Integrations",
    description:
      "Wire Claude Code to use Tierkit's MCP server. Registers the tierkit MCP entry in ~/.claude.json or workspace .mcp.json, and appends a marker block to CLAUDE.md telling Claude Code when to use the digest tools.",
    examples: [
      ["Workspace + light instructions (recommended)", "tierkit connect claude-code"],
      ["Global (all projects)", "tierkit connect claude-code --scope global"],
      ["Full required-workflow instructions", "tierkit connect claude-code --instructions full"],
      ["MCP only, no CLAUDE.md edit", "tierkit connect claude-code --instructions none"],
    ],
  });

  scope = Option.String("--scope", "workspace", { description: "global (~/.claude.json) or workspace (./.mcp.json). Default workspace." });
  instructions = Option.String("--instructions", "light", { description: "none | light | full. Default light." });
  cwdFlag = Option.String("--cwd");
  tierkitBinary = Option.String("--tierkit-bin", { description: "Override the `tierkit` command path written into the MCP entry." });

  override async execute(): Promise<number> {
    if (!SCOPES.includes(this.scope as ConnectScope)) {
      this.context.stderr.write(`error: --scope must be one of ${SCOPES.join(", ")}\n`);
      return 1;
    }
    if (!LEVELS.includes(this.instructions as InstructionsLevel)) {
      this.context.stderr.write(`error: --instructions must be one of ${LEVELS.join(", ")}\n`);
      return 1;
    }
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    const r = await connectClaudeCode({
      workspaceRoot: cwd,
      scope: this.scope as ConnectScope,
      instructionsLevel: this.instructions as InstructionsLevel,
      ...(this.tierkitBinary ? { tierkitBinary: this.tierkitBinary } : {}),
    });
    const o = this.context.stdout;
    if (r.alreadyConnected) {
      o.write(`Claude Code already connected (${this.scope}). MCP entry unchanged.\n`);
    } else {
      o.write(`✓ Claude Code connected (${this.scope})\n`);
      o.write(`  MCP entry: ${r.mcpConfigPath} :: mcpServers.${r.mcpServerName}\n`);
    }
    if (r.claudeMdWritten && r.claudeMdPath) {
      o.write(`  Instructions written to: ${r.claudeMdPath} (level=${this.instructions})\n`);
    } else if (this.instructions === "none") {
      o.write(`  CLAUDE.md not touched (--instructions=none)\n`);
    }
    o.write(`\nNext step: restart Claude Code or run "/mcp restart tierkit" so it picks up the new server.\n`);
    return 0;
  }
}

export class DisconnectClaudeCodeCommand extends Command<CliContext> {
  static override paths = [["disconnect", "claude-code"]];

  static override usage = Command.Usage({
    category: "Integrations",
    description: "Remove the tierkit MCP entry and strip the marker block from CLAUDE.md. Reversible.",
    examples: [
      ["Workspace", "tierkit disconnect claude-code"],
      ["Global", "tierkit disconnect claude-code --scope global"],
    ],
  });

  scope = Option.String("--scope", "workspace");
  cwdFlag = Option.String("--cwd");

  override async execute(): Promise<number> {
    if (!SCOPES.includes(this.scope as ConnectScope)) {
      this.context.stderr.write(`error: --scope must be one of ${SCOPES.join(", ")}\n`);
      return 1;
    }
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    const r = await disconnectClaudeCode({
      workspaceRoot: cwd,
      scope: this.scope as ConnectScope,
    });
    const o = this.context.stdout;
    if (!r.mcpEntryRemoved && !r.claudeMdStripped) {
      o.write(`Claude Code was not connected (${this.scope}). Nothing to do.\n`);
      return 0;
    }
    o.write(`✓ Claude Code disconnected (${this.scope})\n`);
    if (r.mcpEntryRemoved) o.write(`  MCP entry removed from: ${r.mcpConfigPath}\n`);
    if (r.claudeMdStripped && r.claudeMdPath) o.write(`  Marker block stripped from: ${r.claudeMdPath}\n`);
    return 0;
  }
}

export class ClaudeCodeStatusCommand extends Command<CliContext> {
  static override paths = [["connect", "claude-code", "status"]];

  static override usage = Command.Usage({
    category: "Integrations",
    description: "Show whether Claude Code is wired to Tierkit (per scope) and where the config lives.",
  });

  cwdFlag = Option.String("--cwd");
  json = Option.Boolean("--json", false);

  override async execute(): Promise<number> {
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    const s = await claudeCodeStatus({ workspaceRoot: cwd });
    if (this.json) {
      this.context.stdout.write(JSON.stringify(s, null, 2) + "\n");
      return 0;
    }
    const o = this.context.stdout;
    o.write(`Claude Code wiring status (workspace: ${cwd}):\n`);
    o.write(`  Global (${s.globalMcpConfigPath}):    ${s.connectedGlobal ? "✓ connected" : "✗ not connected"}\n`);
    o.write(`  Workspace (${s.workspaceMcpConfigPath}): ${s.connectedWorkspace ? "✓ connected" : "✗ not connected"}\n`);
    o.write(`  CLAUDE.md instructions: ${s.instructionsInClaudeMd ? "✓ present" : "✗ absent"}\n`);
    return 0;
  }
}
