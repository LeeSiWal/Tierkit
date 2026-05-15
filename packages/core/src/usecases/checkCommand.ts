import { classifyCommand, type CommandClassification } from "../security/dangerousCommands.js";

export interface CheckCommandInput {
  command: string;
}

export type CheckCommandResult = CommandClassification;

export async function checkCommand(input: CheckCommandInput): Promise<CheckCommandResult> {
  return classifyCommand(input.command);
}
