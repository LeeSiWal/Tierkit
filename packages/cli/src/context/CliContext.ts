import type { BaseContext } from "clipanion";

export interface CliContext extends BaseContext {
  cwd: string;
}

export function buildCliContext(): CliContext {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env as Record<string, string>,
    colorDepth: 8,
    cwd: process.cwd(),
  };
}
