import { Builtins, Cli } from "clipanion";
import { TIERKIT_VERSION } from "@tierkit/core";
import type { CliContext } from "./context/CliContext.js";
import { InitCommand } from "./commands/InitCommand.js";
import { DoctorCommand } from "./commands/DoctorCommand.js";
import { ModelsListCommand } from "./commands/models/ModelsListCommand.js";
import { ModelsTestCommand } from "./commands/models/ModelsTestCommand.js";
import { RouteExplainCommand } from "./commands/route/RouteExplainCommand.js";
import { RouteRunCommand } from "./commands/route/RouteRunCommand.js";
import { ContextBuildCommand } from "./commands/context/ContextBuildCommand.js";
import { ContextShowCommand } from "./commands/context/ContextShowCommand.js";
import { ContextSendCommand } from "./commands/context/ContextSendCommand.js";
import { ContextCompareCommand } from "./commands/context/ContextCompareCommand.js";
import { ContextPackCommand } from "./commands/context/ContextPackCommand.js";
import { DigestCommandCommand } from "./commands/digest/DigestCommandCommand.js";
import { DigestErrorCommand } from "./commands/digest/DigestErrorCommand.js";
import { DigestTestCommand } from "./commands/digest/DigestTestCommand.js";
import { DigestJsonCommand } from "./commands/digest/DigestJsonCommand.js";
import { DigestFileCommand } from "./commands/digest/DigestFileCommand.js";
import { DigestDiffCommand } from "./commands/digest/DigestDiffCommand.js";
import { ConfigShowCommand } from "./commands/config/ConfigShowCommand.js";
import { CheckRedactCommand } from "./commands/check/CheckRedactCommand.js";
import { CheckCommandCommand } from "./commands/check/CheckCommandCommand.js";
import { CheckPathCommand } from "./commands/check/CheckPathCommand.js";
import { RuntimeStartCommand } from "./commands/runtime/RuntimeStartCommand.js";
import { RuntimeStopCommand } from "./commands/runtime/RuntimeStopCommand.js";
import { RuntimeStatusCommand } from "./commands/runtime/RuntimeStatusCommand.js";
import { UsageCommand } from "./commands/UsageCommand.js";
import { ProfileAddCommand } from "./commands/profile/ProfileAddCommand.js";
import { ProfileRemoveCommand } from "./commands/profile/ProfileRemoveCommand.js";
import { ConnectCommand } from "./commands/ConnectCommand.js";
import {
  ConnectClaudeCodeCommand,
  DisconnectClaudeCodeCommand,
  ClaudeCodeStatusCommand,
} from "./commands/connect/ConnectClaudeCodeCommand.js";
import { McpServeCommand } from "./commands/mcp/McpServeCommand.js";
import { McpPatchListCommand } from "./commands/mcp/McpPatchListCommand.js";
import { McpPatchApproveCommand } from "./commands/mcp/McpPatchApproveCommand.js";
import { McpPatchRejectCommand } from "./commands/mcp/McpPatchRejectCommand.js";

/* v0.19 disabled — out of scope for Context Gateway pivot.
 * Re-enable by uncommenting the import + cli.register() below and the entries
 * down in buildCli(). Source files are kept on disk in case we revive the
 * plugin runtime or workflow sessions later.
 *
 * import { PluginValidateCommand } from "./commands/plugin/PluginValidateCommand.js";
 * import { PluginInstallCommand } from "./commands/plugin/PluginInstallCommand.js";
 * import { PluginListCommand } from "./commands/plugin/PluginListCommand.js";
 * import { PluginEnableCommand } from "./commands/plugin/PluginEnableCommand.js";
 * import { PluginDisableCommand } from "./commands/plugin/PluginDisableCommand.js";
 * import { PluginRemoveCommand } from "./commands/plugin/PluginRemoveCommand.js";
 * import { PluginSyncCommand } from "./commands/plugin/PluginSyncCommand.js";
 * import { PluginNewCommand } from "./commands/plugin/PluginNewCommand.js";
 * import { ExportGenericCommand } from "./commands/export/ExportGenericCommand.js";
 * import { ExportRooCommand } from "./commands/export/ExportRooCommand.js";
 * import { ExportClineCommand } from "./commands/export/ExportClineCommand.js";
 * import { ExportContinueCommand } from "./commands/export/ExportContinueCommand.js";
 * import { SessionStartCommand } from "./commands/session/SessionStartCommand.js";
 * import { SessionStatusCommand } from "./commands/session/SessionStatusCommand.js";
 * import { SessionAdvanceCommand } from "./commands/session/SessionAdvanceCommand.js";
 * import { SessionApprovePlanCommand } from "./commands/session/SessionApprovePlanCommand.js";
 * import { SessionAbandonCommand } from "./commands/session/SessionAbandonCommand.js";
 */

export function buildCli(): Cli<CliContext> {
  const cli = new Cli<CliContext>({
    binaryLabel: "Tierkit",
    binaryName: "tierkit",
    // v0.12.1: sourced from @tierkit/core (tsup `__TIERKIT_VERSION__` define
    // → packages/core/package.json#version). Previously a hardcoded literal
    // that silently drifted from package.json — see v0.11.1 spec for context.
    binaryVersion: TIERKIT_VERSION,
  });

  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);

  // ── Setup + diagnostics ──────────────────────────────────────────────────
  cli.register(InitCommand);
  cli.register(DoctorCommand);
  cli.register(ConnectCommand);
  // v0.20: Claude Code auto-wire
  cli.register(ConnectClaudeCodeCommand);
  cli.register(DisconnectClaudeCodeCommand);
  cli.register(ClaudeCodeStatusCommand);

  // ── Model profiles + routing (powers the Compress refine step) ──────────
  cli.register(ModelsListCommand);
  cli.register(ModelsTestCommand);
  cli.register(RouteExplainCommand);
  cli.register(RouteRunCommand);
  cli.register(ProfileAddCommand);
  cli.register(ProfileRemoveCommand);

  // ── Context compression (v0.11 ripgrep-driven pipeline) ─────────────────
  cli.register(ContextBuildCommand);
  cli.register(ContextShowCommand);
  cli.register(ContextSendCommand);
  cli.register(ContextCompareCommand);

  // ── Security gates (used by daemon + MCP) ───────────────────────────────
  cli.register(ConfigShowCommand);
  cli.register(CheckRedactCommand);
  cli.register(CheckCommandCommand);
  cli.register(CheckPathCommand);

  // ── Runtime daemon ──────────────────────────────────────────────────────
  cli.register(RuntimeStartCommand);
  cli.register(RuntimeStopCommand);
  cli.register(RuntimeStatusCommand);
  cli.register(UsageCommand);

  // ── MCP bridge (the primary Claude Code integration) ────────────────────
  cli.register(McpServeCommand);
  cli.register(McpPatchListCommand);
  cli.register(McpPatchApproveCommand);
  cli.register(McpPatchRejectCommand);

  // ── v0.18 Context Gateway: digest + pack commands ───────────────────────
  cli.register(ContextPackCommand);
  cli.register(DigestCommandCommand);
  cli.register(DigestErrorCommand);
  cli.register(DigestTestCommand);
  cli.register(DigestJsonCommand);
  cli.register(DigestFileCommand);
  cli.register(DigestDiffCommand);

  /* v0.19 disabled — re-enable the matching `import`s above first.
   *
   * cli.register(PluginValidateCommand);
   * cli.register(PluginInstallCommand);
   * cli.register(PluginListCommand);
   * cli.register(PluginEnableCommand);
   * cli.register(PluginDisableCommand);
   * cli.register(PluginRemoveCommand);
   * cli.register(PluginSyncCommand);
   * cli.register(PluginNewCommand);
   * cli.register(ExportGenericCommand);
   * cli.register(ExportRooCommand);
   * cli.register(ExportClineCommand);
   * cli.register(ExportContinueCommand);
   * cli.register(SessionStartCommand);
   * cli.register(SessionStatusCommand);
   * cli.register(SessionAdvanceCommand);
   * cli.register(SessionApprovePlanCommand);
   * cli.register(SessionAbandonCommand);
   */

  return cli;
}
