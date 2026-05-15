import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config/loadConfig.js";
import { ExecutionSessionSchema, type ExecutionSession } from "./ExecutionSession.js";

const SESSIONS_DIR = "sessions";
const CURRENT_POINTER = "current";

async function paths(projectRoot: string): Promise<{ dir: string; current: string }> {
  const cfg = await loadConfig(projectRoot);
  const root = path.join(projectRoot, cfg.config.runtime.dataDir, SESSIONS_DIR);
  return { dir: root, current: path.join(root, CURRENT_POINTER) };
}

function sessionFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

export async function writeSession(projectRoot: string, session: ExecutionSession): Promise<void> {
  const { dir } = await paths(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(sessionFile(dir, session.id), JSON.stringify(session, null, 2) + "\n", "utf8");
}

export async function readSession(projectRoot: string, id: string): Promise<ExecutionSession | undefined> {
  const { dir } = await paths(projectRoot);
  try {
    const raw = JSON.parse(await fs.readFile(sessionFile(dir, id), "utf8"));
    return ExecutionSessionSchema.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function setCurrentSessionId(projectRoot: string, id: string | null): Promise<void> {
  const { dir, current } = await paths(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  if (id === null) {
    await fs.rm(current, { force: true });
  } else {
    await fs.writeFile(current, id, "utf8");
  }
}

export async function readCurrentSessionId(projectRoot: string): Promise<string | undefined> {
  const { current } = await paths(projectRoot);
  try {
    const id = (await fs.readFile(current, "utf8")).trim();
    return id.length > 0 ? id : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function readCurrentSession(projectRoot: string): Promise<ExecutionSession | undefined> {
  const id = await readCurrentSessionId(projectRoot);
  if (!id) return undefined;
  return readSession(projectRoot, id);
}

export function newSessionId(): string {
  return randomUUID();
}
