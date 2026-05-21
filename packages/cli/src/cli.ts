import { Builtins, Cli } from "clipanion";
import { TIERKIT_VERSION } from "@tierkit/core";
import type { CliContext } from "./context/CliContext.js";
import { InitCommand } from "./commands/InitCommand.js";
import { DoctorCommand } from "./commands/DoctorCommand.js";
import { PluginValidateCommand } from "./commands/plugin/PluginValidateCommand.js";
import { PluginInstallCommand } from "./commands/plugin/PluginInstallCommand.js";
import { PluginListCommand } from "./commands/plugin/PluginListCommand.js";
import { ExportGenericCommand } from "./commands/export/ExportGenericCommand.js";
import { ExportRooCommand } from "./commands/export/ExportRooCommand.js";
import { ExportClineCommand } from "./commands/export/ExportClineCommand.js";
import { ExportContinueCommand } from "./commands/export/ExportContinueCommand.js";
import { ModelsListCommand } from "./commands/models/ModelsListCommand.js";
import { ModelsTestCommand } from "./commands/models/ModelsTestCommand.js";
import { RouteExplainCommand } from "./commands/route/RouteExplainCommand.js";
import { RouteRunCommand } from "./commands/route/RouteRunCommand.js";
import { ContextBuildCommand } from "./commands/context/ContextBuildCommand.js";
import { ContextShowCommand } from "./commands/context/ContextShowCommand.js";
import { ContextSendCommand } from "./commands/context/ContextSendCommand.js";
import { ContextCompareCommand } from "./commands/context/ContextCompareCommand.js";
import { ConfigShowCommand } from "./commands/config/ConfigShowCommand.js";
import { CheckRedactCommand } from "./commands/check/CheckRedactCommand.js";
import { CheckCommandCommand } from "./commands/check/CheckCommandCommand.js";
import { CheckPathCommand } from "./commands/check/CheckPathCommand.js";
import { RuntimeStartCommand } from "./commands/runtime/RuntimeStartCommand.js";
import { RuntimeStopCommand } from "./commands/runtime/RuntimeStopCommand.js";
import { RuntimeStatusCommand } from "./commands/runtime/RuntimeStatusCommand.js";
import { UsageCommand } from "./commands/UsageCommand.js";
import { PluginEnableCommand } from "./commands/plugin/PluginEnableCommand.js";
import { PluginDisableCommand } from "./commands/plugin/PluginDisableCommand.js";
import { PluginRemoveCommand } from "./commands/plugin/PluginRemoveCommand.js";
import { SessionStartCommand } from "./commands/session/SessionStartCommand.js";
import { SessionStatusCommand } from "./commands/session/SessionStatusCommand.js";
import { SessionAdvanceCommand } from "./commands/session/SessionAdvanceCommand.js";
import { SessionApprovePlanCommand } from "./commands/session/SessionApprovePlanCommand.js";
import { SessionAbandonCommand } from "./commands/session/SessionAbandonCommand.js";
import { ProfileAddCommand } from "./commands/profile/ProfileAddCommand.js";
import { ProfileRemoveCommand } from "./commands/profile/ProfileRemoveCommand.js";
import { ConnectCommand } from "./commands/ConnectCommand.js";
import { PluginSyncCommand } from "./commands/plugin/PluginSyncCommand.js";
import { PluginNewCommand } from "./commands/plugin/PluginNewCommand.js";
import { McpServeCommand } from "./commands/mcp/McpServeCommand.js";
import { McpPatchListCommand } from "./commands/mcp/McpPatchListCommand.js";
import { McpPatchApproveCommand } from "./commands/mcp/McpPatchApproveCommand.js";
import { McpPatchRejectCommand } from "./commands/mcp/McpPatchRejectCommand.js";

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

  cli.register(InitCommand);
  cli.register(DoctorCommand);
  cli.register(PluginValidateCommand);
  cli.register(PluginInstallCommand);
  cli.register(PluginListCommand);
  cli.register(ExportGenericCommand);
  cli.register(ExportRooCommand);
  cli.register(ExportClineCommand);
  cli.register(ExportContinueCommand);
  cli.register(ModelsListCommand);
  cli.register(ModelsTestCommand);
  cli.register(RouteExplainCommand);
  cli.register(RouteRunCommand);
  cli.register(ContextBuildCommand);
  cli.register(ContextShowCommand);
  cli.register(ContextSendCommand);
  cli.register(ContextCompareCommand);
  cli.register(ConfigShowCommand);
  cli.register(CheckRedactCommand);
  cli.register(CheckCommandCommand);
  cli.register(CheckPathCommand);
  cli.register(RuntimeStartCommand);
  cli.register(RuntimeStopCommand);
  cli.register(RuntimeStatusCommand);
  cli.register(UsageCommand);
  cli.register(PluginEnableCommand);
  cli.register(PluginDisableCommand);
  cli.register(PluginRemoveCommand);
  cli.register(SessionStartCommand);
  cli.register(SessionStatusCommand);
  cli.register(SessionAdvanceCommand);
  cli.register(SessionApprovePlanCommand);
  cli.register(SessionAbandonCommand);
  cli.register(ProfileAddCommand);
  cli.register(ProfileRemoveCommand);
  cli.register(ConnectCommand);
  cli.register(PluginSyncCommand);
  cli.register(PluginNewCommand);
  cli.register(McpServeCommand);
  cli.register(McpPatchListCommand);
  cli.register(McpPatchApproveCommand);
  cli.register(McpPatchRejectCommand);

  return cli;
}
