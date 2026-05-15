import { matchSensitive } from "../security/sensitiveFiles.js";

export interface CheckPathInput {
  pathToCheck: string;
}

export interface CheckPathResult {
  pathChecked: string;
  sensitive: boolean;
  matchedPatterns: string[];
}

export async function checkPath(input: CheckPathInput): Promise<CheckPathResult> {
  const matched = matchSensitive(input.pathToCheck);
  return {
    pathChecked: input.pathToCheck,
    sensitive: matched.length > 0,
    matchedPatterns: matched,
  };
}
