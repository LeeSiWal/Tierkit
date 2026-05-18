import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { startServer, type RunningServer } from "../runtime/Server.js";
import { TierkitError } from "../errors/TierkitError.js";

export class RuntimeError extends TierkitError {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

const PID_FILE = "daemon.pid";
const PORT_FILE = "daemon.port";

export interface RuntimeStartInput {
  cwd?: string;
  port?: number;
  host?: string;
}

export interface RuntimeStartResult {
  pid: number;
  host: string;
  port: number;
  baseUrl: string;
  dataDir: string;
  /** Handle for the caller to gracefully shut down the server (CLI uses this on SIGINT). */
  server: RunningServer;
}

/**
 * Start the runtime server. Writes a pid + port file under `dataDir`. The caller (CLI)
 * is responsible for handling SIGINT/SIGTERM and calling `server.close()` + cleaning the
 * pid file. Throws `RuntimeError(code: "already-running")` if the recorded pid is alive.
 */
export async function startRuntime(input: RuntimeStartInput = {}): Promise<RuntimeStartResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  const rc = cfg.config.runtime;
  const dataDir = path.join(projectRoot, rc.dataDir);
  await fs.mkdir(dataDir, { recursive: true });

  const pidPath = path.join(dataDir, PID_FILE);
  const portPath = path.join(dataDir, PORT_FILE);

  const existingPid = await readPidIfAlive(pidPath);
  if (existingPid !== undefined) {
    let existingPort: number | undefined;
    try {
      existingPort = Number.parseInt(await fs.readFile(portPath, "utf8"), 10);
    } catch {
      /* ignore */
    }
    throw new RuntimeError(
      "already-running",
      `tierkit runtime is already running with pid ${existingPid}${existingPort ? ` on port ${existingPort}` : ""}. ` +
        `Run \`tierkit runtime stop\` first.`,
    );
  }

  const host = input.host ?? rc.host;
  const port = input.port ?? rc.port;

  const { createSecretsStore } = await import("../security/SecretsStore.js");
  const secrets = createSecretsStore({ dataDir });
  await secrets.loadIntoEnv();

  const server = await startServer({ cwd: projectRoot, host, port, secrets });
  await fs.writeFile(pidPath, String(process.pid), "utf8");
  await fs.writeFile(portPath, String(server.port), "utf8");

  return {
    pid: process.pid,
    host: server.address,
    port: server.port,
    baseUrl: `http://${server.address}:${server.port}`,
    dataDir,
    server,
  };
}

export interface RuntimeStopInput {
  cwd?: string;
}

export interface RuntimeStopResult {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

export async function stopRuntime(input: RuntimeStopInput = {}): Promise<RuntimeStopResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  const dataDir = path.join(projectRoot, cfg.config.runtime.dataDir);
  const pidPath = path.join(dataDir, PID_FILE);

  let pid: number | undefined;
  try {
    pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { stopped: false, reason: "no daemon pid file — runtime is not running" };
    }
    throw err;
  }
  if (!pid || Number.isNaN(pid)) {
    await fs.rm(pidPath, { force: true });
    return { stopped: false, reason: "pid file was malformed; cleaned up" };
  }
  if (!isPidAlive(pid)) {
    await fs.rm(pidPath, { force: true });
    return { stopped: false, pid, reason: `pid ${pid} not alive; cleaned up stale pid file` };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    throw new RuntimeError("kill-failed", `failed to send SIGTERM to pid ${pid}: ${(err as Error).message}`);
  }
  await fs.rm(pidPath, { force: true });
  return { stopped: true, pid };
}

export interface RuntimeStatusInput {
  cwd?: string;
}

export interface RuntimeStatusResult {
  running: boolean;
  pid?: number;
  port?: number;
  baseUrl?: string;
  /** Result of GET /v1/health if reachable. */
  health?: unknown;
  reason?: string;
}

export async function runtimeStatus(input: RuntimeStatusInput = {}): Promise<RuntimeStatusResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);
  const dataDir = path.join(projectRoot, cfg.config.runtime.dataDir);
  const pidPath = path.join(dataDir, PID_FILE);
  const portPath = path.join(dataDir, PORT_FILE);

  let pid: number | undefined;
  let port: number | undefined;
  try {
    pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
  } catch {
    return { running: false, reason: "no pid file" };
  }
  try {
    port = Number.parseInt(await fs.readFile(portPath, "utf8"), 10);
  } catch {
    /* ignore */
  }
  if (!pid || Number.isNaN(pid) || !isPidAlive(pid)) {
    return { running: false, ...(pid ? { pid } : {}), reason: pid ? `pid ${pid} not alive` : "no pid" };
  }

  const baseUrl = port ? `http://${cfg.config.runtime.host}:${port}` : undefined;
  let health: unknown;
  if (baseUrl) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) health = await res.json();
    } catch {
      /* leave health undefined */
    }
  }
  return {
    running: true,
    pid,
    ...(port ? { port } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(health ? { health } : {}),
  };
}

async function readPidIfAlive(pidPath: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
    if (pid && !Number.isNaN(pid) && isPidAlive(pid)) return pid;
  } catch {
    /* ignore */
  }
  return undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
