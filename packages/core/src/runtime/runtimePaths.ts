import path from "node:path";
export function resolveRuntimeDataDir(dataDir: string, cwd: string): string {
  return path.isAbsolute(dataDir) ? dataDir : path.resolve(cwd, dataDir);
}
