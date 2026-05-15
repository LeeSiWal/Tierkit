import fs from "node:fs/promises";
import path from "node:path";
import { redactSecrets, type RedactionRule } from "../security/SecretRedactor.js";

export interface CheckRedactInput {
  filePath: string;
  cwd?: string;
  /** Inject custom rules (defaults to the built-in `DEFAULT_REDACTION_RULES`). */
  rules?: readonly RedactionRule[];
}

export interface CheckRedactResult {
  filePath: string;
  bytesIn: number;
  bytesOut: number;
  hits: { ruleId: string; count: number }[];
  redacted: string;
}

export async function checkRedact(input: CheckRedactInput): Promise<CheckRedactResult> {
  const cwd = input.cwd ?? process.cwd();
  const abs = path.isAbsolute(input.filePath) ? input.filePath : path.resolve(cwd, input.filePath);
  const raw = await fs.readFile(abs, "utf8");
  const result = redactSecrets(raw, input.rules);
  return {
    filePath: abs,
    bytesIn: raw.length,
    bytesOut: result.text.length,
    hits: result.hits,
    redacted: result.text,
  };
}
