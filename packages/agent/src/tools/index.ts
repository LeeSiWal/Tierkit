import { readFileTool } from "./readFile.js";
import { listFilesTool } from "./listFiles.js";
import { searchFilesTool } from "./searchFiles.js";
import { writeFileTool } from "./writeFile.js";
import { executeCommandTool } from "./executeCommand.js";
import { applyDiffTool } from "./applyDiff.js";
import { askFollowupQuestionTool } from "./askFollowupQuestion.js";
import { searchAndReplaceTool } from "./searchAndReplace.js";
import { codebaseSearchTool } from "./codebaseSearch.js";
import type { Tool } from "../types.js";

export {
  readFileTool,
  listFilesTool,
  searchFilesTool,
  writeFileTool,
  executeCommandTool,
  applyDiffTool,
  askFollowupQuestionTool,
  searchAndReplaceTool,
  codebaseSearchTool,
};

/** The default tool set, in the order they're presented to the model. */
export const DEFAULT_TOOLS: Tool[] = [
  readFileTool,
  listFilesTool,
  searchFilesTool,
  codebaseSearchTool,
  applyDiffTool,
  searchAndReplaceTool,
  writeFileTool,
  executeCommandTool,
  askFollowupQuestionTool,
];

export function findTool(name: string): Tool | undefined {
  return DEFAULT_TOOLS.find((t) => t.name === name);
}
