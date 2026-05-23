/**
 * v0.20: auto-wire Claude Code to use the Tierkit MCP server.
 *
 * Without this, the user has to:
 *   1. Manually edit ~/.claude.json or workspace .mcp.json to add the tierkit
 *      MCP server entry, AND
 *   2. Manually edit CLAUDE.md to tell Claude Code "use tierkit.compress_command
 *      before processing long inputs".
 *
 * This module does both reversibly, with safe merge — every edit is guarded
 * by a TIERKIT_* marker so we never touch the user's own MCP servers or
 * CLAUDE.md content.
 *
 * Connect:
 *   - Adds an "tierkit" entry to .mcpServers (global ~/.claude.json or
 *     workspace .mcp.json depending on scope).
 *   - Appends a marked block to ./CLAUDE.md with instructions describing
 *     when to use each digest tool.
 *
 * Disconnect:
 *   - Removes the "tierkit" entry from the MCP config (only the one we own).
 *   - Strips the marked block from CLAUDE.md.
 *
 * Status:
 *   - Reports whether the global+workspace MCP entry exists, whether
 *     CLAUDE.md has our marker block, and where the files live.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/** True when a binary path looks like an Electron-based IDE host (VS Code,
 * Cursor, Windsurf, etc.) rather than a plain Node runtime. Electron hosts
 * require ELECTRON_RUN_AS_NODE=1 to execute JS scripts as a Node process;
 * plain Node ignores that env var, so setting it would be harmless but noisy.
 * On code-server / devcontainers / Codespaces the path is the real node
 * binary so we want to leave the env clean. */
function looksLikeElectron(binPath: string): boolean {
  const lower = binPath.toLowerCase();
  // macOS app-bundle layouts: /Applications/.../Contents/MacOS/{Electron,Code Helper,Cursor,Code,Windsurf}
  if (/\.app\//.test(binPath) && /\/contents\/macos\//i.test(binPath)) return true;
  // Bare names of common Electron-host binaries.
  if (/[\\\/](electron|code|code-helper|cursor|windsurf|trae)(\.exe)?$/i.test(lower)) return true;
  // Linux app paths typically used by VS Code .deb / .rpm.
  if (lower.includes("/usr/share/code/code") || lower.includes("/opt/visual studio code/")) return true;
  return false;
}

/** True if the input looks like an absolute or relative path (vs a bare binary
 *  name to be looked up in PATH). Handles both POSIX (`/foo`, `./foo`) and
 *  Windows (`C:\foo`, `\\share\foo`, `.\foo`). */
function looksLikePath(s: string): boolean {
  if (s.includes("/")) return true;
  if (IS_WINDOWS) {
    if (s.includes("\\")) return true;
    if (/^[A-Za-z]:/.test(s)) return true;
  }
  return false;
}

/** Existence + (Unix-only) executability check. On Windows fs.constants.X_OK
 *  is meaningless — every readable file is treated as executable, and the
 *  PATHEXT extension is what actually determines whether the OS will run it. */
async function isExecutable(p: string): Promise<boolean> {
  try {
    if (IS_WINDOWS) {
      const st = await fs.stat(p);
      return st.isFile();
    }
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Expand a bare binary name to all the filenames that the OS would try.
 *  On POSIX that's just `[name]`. On Windows it's `[name, name.exe, name.cmd,
 *  ...]` derived from PATHEXT. */
function nameCandidates(binary: string): string[] {
  if (!IS_WINDOWS) return [binary];
  // If the user already supplied an extension, trust it.
  if (/\.[A-Za-z0-9]{1,4}$/.test(binary)) return [binary];
  const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC")
    .split(";").map((e) => e.trim()).filter(Boolean);
  const out = new Set<string>();
  out.add(binary);
  for (const ext of pathExt) {
    out.add(binary + ext.toLowerCase());
    out.add(binary + ext.toUpperCase());
  }
  return [...out];
}

/** GUI-process fallback dirs — common install locations that are usually
 *  absent from the PATH of a process started by `launchd` (macOS dock click)
 *  or by the Windows GUI shell. */
function guiFallbackDirs(): string[] {
  const home = os.homedir();
  if (IS_WINDOWS) {
    return [
      path.join(home, "AppData", "Roaming", "npm"),                  // npm global default
      path.join(home, "AppData", "Local", "Programs", "nodejs"),      // user-local Node
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
      path.join(home, "scoop", "shims"),                              // scoop
      "C:\\ProgramData\\chocolatey\\bin",                            // chocolatey
      path.join(home, "AppData", "Local", "Yarn", "bin"),             // yarn classic
      path.join(home, "AppData", "Roaming", "pnpm"),                  // pnpm global
      path.join(home, "AppData", "Local", "pnpm"),
      path.join(home, ".volta", "bin"),                               // volta
    ];
  }
  // POSIX (macOS + Linux + code-server / Codespaces / devcontainers):
  return [
    "/opt/homebrew/bin",                        // Apple Silicon Homebrew
    "/usr/local/bin",                            // Intel Homebrew + manual installs
    "/usr/bin",                                  // system
    "/opt/local/bin",                            // MacPorts
    "/snap/bin",                                 // Linux snap packages (claude CLI often here)
    "/usr/lib/node_modules/.bin",                // some Linux node distributions
    "/var/lib/snapd/snap/bin",                   // alt snap location
    path.join(home, ".local", "bin"),            // pip/cargo --user
    path.join(home, ".npm-global", "bin"),       // npm prefix
    path.join(home, ".local", "share", "npm", "bin"), // XDG npm prefix
    path.join(home, ".volta", "bin"),            // volta
    path.join(home, ".bun", "bin"),              // bun (claude can ship via bun)
    path.join(home, ".deno", "bin"),             // deno
    path.join(home, "bin"),                      // catch-all manual installs
    "/opt/code-server/bin",                      // code-server bundled dirs
    "/usr/local/code-server/bin",
  ];
}

/**
 * Resolve the absolute path of a binary the way a login shell would,
 * even when this process is GUI-launched (launchd / explorer.exe / VS Code
 * dock click) and has a stripped PATH that doesn't include the user's
 * package-manager bin dirs.
 *
 * Why we need this: when the user clicks Connect, we write a JSON entry
 * with `"command": "tierkit"` into Claude Code's MCP config. Claude Code's
 * extension host runs in the same stripped-PATH GUI process — so it spawns
 * `tierkit` and fails with ENOENT, surfacing as "Failed" in /mcp. Writing
 * the absolute path here avoids the entire PATH problem.
 *
 * Cross-platform:
 *   - POSIX: PATH + common bin dirs + nvm/n versioned scans.
 *   - Windows: PATH + npm/scoop/chocolatey/yarn/pnpm/volta locations, with
 *     PATHEXT-driven filename expansion (`.exe`, `.cmd`, `.bat`, …).
 *
 * Returns null if the binary genuinely can't be found anywhere.
 */
async function resolveBinaryPath(binary: string): Promise<string | null> {
  // Caller-supplied path — trust it but still verify it exists.
  if (looksLikePath(binary)) {
    return (await isExecutable(binary)) ? binary : null;
  }

  const candidates = nameCandidates(binary);
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const fallbacks = guiFallbackDirs();

  for (const dir of [...pathDirs, ...fallbacks]) {
    for (const c of candidates) {
      const full = path.join(dir, c);
      if (await isExecutable(full)) return full;
    }
  }

  // Unix-only: nvm / n place each Node version in its own dir — scan one level deeper.
  if (!IS_WINDOWS) {
    for (const root of [
      path.join(os.homedir(), ".nvm", "versions", "node"),
      "/usr/local/n/versions/node",
    ]) {
      try {
        const versions = await fs.readdir(root);
        versions.sort().reverse();
        for (const v of versions) {
          const full = path.join(root, v, "bin", binary);
          if (await isExecutable(full)) return full;
        }
      } catch { /* root doesn't exist */ }
    }
  }

  return null;
}

export type ConnectScope = "global" | "workspace";
export type InstructionsLevel = "none" | "light" | "full";

export interface ConnectClaudeCodeInput {
  workspaceRoot: string;
  scope: ConnectScope;
  instructionsLevel: InstructionsLevel;
  /** Override which `tierkit` binary the MCP entry calls. Default "tierkit".
   * Ignored when cliPath is provided. */
  tierkitBinary?: string;
  /**
   * v0.20.7: absolute path to a bundled CLI script (the Extension ships one
   * inside the .vsix at <extensionPath>/cli/index.js). When provided, the
   * MCP entry is written as `node <cliPath> mcp serve …` so the spawn target
   * never depends on a global `tierkit` install.
   */
  cliPath?: string;
  /**
   * v0.20.7: absolute path to a Node-compatible binary to launch the cliPath.
   * The Extension passes `process.execPath` (VS Code's bundled Electron) here;
   * combined with env `ELECTRON_RUN_AS_NODE=1` it acts as Node and is always
   * reachable since the user already has VS Code installed. If unset, we try
   * to resolve `node` from PATH/fallbacks.
   */
  nodeBinary?: string;
  /** Override the home directory (test injection). Default os.homedir(). */
  homeDir?: string;
}

export interface ConnectClaudeCodeResult {
  ok: true;
  mcpConfigPath: string;
  mcpServerName: string;
  claudeMdPath: string | null;
  claudeMdWritten: boolean;
  alreadyConnected: boolean;
  /** v0.20.4: post-write verification — confirms the JSON entry round-trips
   * AND a `tierkit --version` subprocess actually launches with that command.
   * If either fails, Claude Code will show "Failed" in /mcp, so we surface
   * this BEFORE the user reloads. */
  verification: {
    fileWritten: boolean;
    fileContainsEntry: boolean;
    binaryLaunchable: boolean;
    binaryError?: string;
    resolvedCommand: string;
  };
}

export interface DisconnectClaudeCodeInput {
  workspaceRoot: string;
  scope: ConnectScope;
  homeDir?: string;
}

export interface DisconnectClaudeCodeResult {
  ok: true;
  mcpConfigPath: string;
  mcpEntryRemoved: boolean;
  claudeMdPath: string | null;
  claudeMdStripped: boolean;
}

export interface ClaudeCodeStatusInput {
  workspaceRoot: string;
  homeDir?: string;
}

export interface ClaudeCodeStatusResult {
  globalMcpConfigPath: string;
  workspaceMcpConfigPath: string;
  claudeMdPath: string;
  connectedGlobal: boolean;
  connectedWorkspace: boolean;
  instructionsInClaudeMd: boolean;
}

// Marker for the CLAUDE.md instruction block. Disconnect strips everything
// between the two markers (inclusive). Keep these strings stable across
// versions — changing them will orphan old marker blocks.
const TK_BEGIN_MARKER = "<!-- TIERKIT MCP INSTRUCTIONS — managed by `tierkit connect claude-code`; remove via `tierkit disconnect claude-code`. Do not edit between markers. -->";
const TK_END_MARKER = "<!-- /TIERKIT MCP INSTRUCTIONS -->";
const TK_MCP_SERVER_NAME = "tierkit";

// ── path helpers ──────────────────────────────────────────────────────────

function globalMcpPath(homeDir: string): string {
  return path.join(homeDir, ".claude.json");
}

function workspaceMcpPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".mcp.json");
}

function claudeMdPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "CLAUDE.md");
}

// ── safe JSON read/write ──────────────────────────────────────────────────

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonPreserving(p: string, obj: Record<string, unknown>): Promise<void> {
  // Pretty-print with 2 spaces to match Claude Code's own conventions.
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n");
}

// ── MCP server entry ──────────────────────────────────────────────────────

function buildTierkitMcpEntry(workspaceRoot: string, tierkitBinary: string): Record<string, unknown> {
  return {
    type: "stdio",
    command: tierkitBinary,
    args: ["mcp", "serve", "--workspace", workspaceRoot],
    env: {},
  };
}

/** v0.20.7: build MCP entry as `node cliPath mcp serve …`. Used when the
 *  Extension hands us a bundled CLI absolute path — avoids requiring a global
 *  `tierkit` install on the user's machine. */
function buildBundledCliEntry(
  workspaceRoot: string,
  nodeBinary: string,
  cliPath: string,
  useElectronAsNode: boolean,
): Record<string, unknown> {
  return {
    type: "stdio",
    command: nodeBinary,
    args: [cliPath, "mcp", "serve", "--workspace", workspaceRoot],
    env: useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

function getMcpServersObject(cfg: Record<string, unknown>): Record<string, unknown> {
  const existing = cfg.mcpServers;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  return {};
}

// ── CLAUDE.md instruction block ──────────────────────────────────────────

function buildInstructionsBlock(level: InstructionsLevel): string {
  if (level === "none") return "";

  const lightLines = [
    TK_BEGIN_MARKER,
    "",
    "## Tierkit Context Gateway",
    "",
    "Tierkit's MCP server is connected. Before processing lengthy inputs, prefer the compressed equivalents:",
    "",
    "- `tierkit.compress_command` — compress a multi-paragraph user task into a structured brief.",
    "- `tierkit.get_error_digest` — summarize build/test/runtime error logs (drops node_modules frames).",
    "- `tierkit.get_test_digest` — extract failed cases from vitest/jest/pytest output.",
    "- `tierkit.get_diff_summary` — summarize `git diff` instead of reading the full patch.",
    "- `tierkit.get_file_digest <path>` — skeleton + symbols for a file; prefer over `Read` on files >300 lines.",
    "- `tierkit.build_context_pack` — assemble a multi-source Context Pack in one call.",
    "",
    "These are local-only and run before any cloud-token cost. Saving tokens here saves money on every turn.",
    "",
    TK_END_MARKER,
  ];

  const fullLines = [
    TK_BEGIN_MARKER,
    "",
    "## Tierkit Context Gateway — required workflow",
    "",
    "**Always use the Tierkit MCP digest tools before reading raw context.** Tierkit compresses inputs locally to save cloud tokens.",
    "",
    "### When the user sends a task longer than ~200 chars",
    "Call `tierkit.compress_command` with the raw text. Use the returned `compressed` as your effective task brief; surface `uncertainty` items back to the user if non-empty.",
    "",
    "### When you need to look at a file",
    "1. First call `tierkit.get_file_digest` with the path.",
    "2. Read the returned `summaryMd` and `importantSymbols`.",
    "3. Only call `Read` on the original file if the digest does not contain the specific lines you need.",
    "",
    "### When you need to look at build / test output",
    "Call `tierkit.get_error_digest` or `tierkit.get_test_digest` on the raw stderr/stdout. Do not paste the raw log into your reasoning.",
    "",
    "### When you need to see current changes",
    "Call `tierkit.get_diff_summary` instead of running `git diff` and reading the full patch.",
    "",
    "### When you need a multi-source context bundle",
    "Call `tierkit.build_context_pack` once with command + files + includeDiff + errorLog as appropriate, rather than chaining N separate digest calls.",
    "",
    "### Safety + verdict",
    "Every digest returns an `uncertainty[]` list. If non-empty, surface it to the user before acting on the digest — Tierkit flags cases where the compression may have dropped relevant detail.",
    "",
    TK_END_MARKER,
  ];

  return (level === "full" ? fullLines : lightLines).join("\n");
}

function stripExistingBlock(content: string): { stripped: string; hadBlock: boolean } {
  const startIdx = content.indexOf(TK_BEGIN_MARKER);
  if (startIdx === -1) return { stripped: content, hadBlock: false };
  const endIdx = content.indexOf(TK_END_MARKER, startIdx);
  if (endIdx === -1) {
    // Begin marker without end — be conservative, leave it untouched.
    return { stripped: content, hadBlock: false };
  }
  const after = endIdx + TK_END_MARKER.length;
  // Also eat one trailing newline if present so we don't accumulate blank lines.
  const trailing = content[after] === "\n" ? 1 : 0;
  // Eat one leading newline before the begin marker too, for the same reason.
  const leading = startIdx > 0 && content[startIdx - 1] === "\n" ? 1 : 0;
  const stripped = content.slice(0, startIdx - leading) + content.slice(after + trailing);
  return { stripped, hadBlock: true };
}

async function writeClaudeMd(workspaceRoot: string, level: InstructionsLevel): Promise<{ path: string; written: boolean }> {
  if (level === "none") return { path: claudeMdPath(workspaceRoot), written: false };
  const target = claudeMdPath(workspaceRoot);
  let existing = "";
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Strip any old block first to ensure idempotency (re-running connect
  // updates the block instead of accumulating duplicates).
  const { stripped } = stripExistingBlock(existing);
  const block = buildInstructionsBlock(level);
  const separator = stripped.length > 0 && !stripped.endsWith("\n") ? "\n\n" : (stripped.length > 0 ? "\n" : "");
  const next = stripped + separator + block + "\n";
  await fs.writeFile(target, next);
  return { path: target, written: true };
}

// ── public API ────────────────────────────────────────────────────────────

export async function connectClaudeCode(input: ConnectClaudeCodeInput): Promise<ConnectClaudeCodeResult> {
  const homeDir = input.homeDir ?? os.homedir();
  const mcpConfigPath = input.scope === "global"
    ? globalMcpPath(homeDir)
    : workspaceMcpPath(input.workspaceRoot);

  // v0.20.7: prefer the bundled-cli path when the caller supplies it (i.e.,
  // when called from the Extension which ships a CLI inside the .vsix).
  // Otherwise fall back to resolving a global `tierkit` binary.
  let desiredEntry: Record<string, unknown>;
  let probeCommand: string;
  let probeArgs: string[] = ["--version"];
  let probeUseShell = false;
  let resolvedCommand: string;
  if (input.cliPath) {
    // Decide which node binary to use. Caller's nodeBinary wins (typically
    // process.execPath); else try to resolve `node` from PATH/fallbacks;
    // else fail soft and let verification surface the issue.
    const nodeBinary = input.nodeBinary
      ?? (await resolveBinaryPath("node"))
      ?? "node";
    // v0.21.11: auto-detect whether the binary is Electron (Electron-based
    // hosts: VS Code Desktop, Cursor, Windsurf — process.execPath points to
    // the Electron binary) or plain Node (server hosts: code-server, devcontainer,
    // Codespaces — process.execPath is the actual node binary).
    //
    // Only Electron needs ELECTRON_RUN_AS_NODE=1 to run scripts. Setting it
    // on a real node binary doesn't break anything but adds noise. Heuristic:
    // look for "electron"/"code helper"/known IDE bundle names in the path.
    const useElectronAsNode = looksLikeElectron(nodeBinary);
    desiredEntry = buildBundledCliEntry(input.workspaceRoot, nodeBinary, input.cliPath, useElectronAsNode);
    probeCommand = nodeBinary;
    probeArgs = [input.cliPath, "--version"];
    resolvedCommand = `${nodeBinary} ${input.cliPath}`;
  } else {
    // Legacy path: spawn the global `tierkit` binary directly.
    const requestedBinary = input.tierkitBinary ?? "tierkit";
    const resolved = await resolveBinaryPath(requestedBinary);
    const tierkitBinary = resolved ?? requestedBinary;
    desiredEntry = buildTierkitMcpEntry(input.workspaceRoot, tierkitBinary);
    probeCommand = tierkitBinary;
    probeUseShell = IS_WINDOWS && /\.(cmd|bat|ps1)$/i.test(tierkitBinary);
    resolvedCommand = tierkitBinary;
  }

  // 1. MCP entry
  const existingCfg = (await readJson(mcpConfigPath)) ?? {};
  const servers = getMcpServersObject(existingCfg);
  const alreadyConnected = JSON.stringify(servers[TK_MCP_SERVER_NAME]) === JSON.stringify(desiredEntry);

  if (!alreadyConnected) {
    const nextCfg: Record<string, unknown> = {
      ...existingCfg,
      mcpServers: {
        ...servers,
        [TK_MCP_SERVER_NAME]: desiredEntry,
      },
    };
    await writeJsonPreserving(mcpConfigPath, nextCfg);
  }

  // 2. CLAUDE.md (always workspace-scoped, regardless of MCP scope)
  const { path: claudeMd, written } = await writeClaudeMd(input.workspaceRoot, input.instructionsLevel);

  // 3. Post-write verification. Confirms (a) the file was actually written,
  //    (b) the JSON contains our entry, and (c) the spawn command launches.
  //    Without this, "Failed" status in Claude Code's /mcp is impossible to
  //    diagnose for the user.
  const verification = await verifyConnect({
    mcpConfigPath,
    probeCommand,
    probeArgs,
    probeUseShell,
    resolvedCommand,
    useElectronAsNode: input.cliPath ? Boolean(input.nodeBinary) : false,
  });

  return {
    ok: true,
    mcpConfigPath,
    mcpServerName: TK_MCP_SERVER_NAME,
    claudeMdPath: input.instructionsLevel === "none" ? null : claudeMd,
    claudeMdWritten: written,
    alreadyConnected,
    verification,
  };
}

interface VerifyConnectInput {
  mcpConfigPath: string;
  probeCommand: string;
  probeArgs: string[];
  probeUseShell: boolean;
  resolvedCommand: string;
  useElectronAsNode: boolean;
}

/** Round-trip the file we just wrote and try to spawn the binary. */
async function verifyConnect(input: VerifyConnectInput): Promise<ConnectClaudeCodeResult["verification"]> {
  let fileWritten = false;
  let fileContainsEntry = false;
  try {
    const raw = await fs.readFile(input.mcpConfigPath, "utf8");
    fileWritten = true;
    const cfg = JSON.parse(raw);
    const servers = (cfg && typeof cfg === "object" && cfg.mcpServers) as Record<string, unknown> | undefined;
    fileContainsEntry = Boolean(servers && servers[TK_MCP_SERVER_NAME]);
  } catch {
    /* file missing or unparseable */
  }
  const binaryProbe = await trySpawn(input.probeCommand, input.probeArgs, {
    useShell: input.probeUseShell,
    extraEnv: input.useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
  });
  return {
    fileWritten,
    fileContainsEntry,
    binaryLaunchable: binaryProbe.ok,
    ...(binaryProbe.ok ? {} : { binaryError: binaryProbe.message }),
    resolvedCommand: input.resolvedCommand,
  };
}

interface TrySpawnOptions {
  useShell?: boolean;
  extraEnv?: Record<string, string>;
}

/** v0.20.7: generalized spawn probe. Used by verifyConnect to confirm the
 *  MCP entry's exact command + args + env actually launches before the user
 *  reloads. */
function trySpawn(binary: string, args: string[], opts: TrySpawnOptions = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(opts.useShell ? { shell: true } : {}),
        env: { ...process.env, ...(opts.extraEnv ?? {}) },
      });
    } catch (err) {
      resolve({ ok: false, message: `spawn threw: ${(err as Error).message}` });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      const installHint = IS_WINDOWS
        ? "Install with `npm i -g @tierkit/cli`, then ensure %APPDATA%\\npm is on PATH, OR pass an absolute path via tierkitBinary."
        : "Install with `npm i -g @tierkit/cli`, OR pass an absolute path via tierkitBinary.";
      resolve({
        ok: false,
        message: code === "ENOENT"
          ? `'${binary}' not found in PATH. ${installHint}`
          : `spawn error: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, message: `'${binary} ${args.join(" ")}' exited with code ${code}. stderr: ${stderr.trim().slice(0, 200)}` });
    });
  });
}

export async function disconnectClaudeCode(input: DisconnectClaudeCodeInput): Promise<DisconnectClaudeCodeResult> {
  const homeDir = input.homeDir ?? os.homedir();
  const mcpConfigPath = input.scope === "global"
    ? globalMcpPath(homeDir)
    : workspaceMcpPath(input.workspaceRoot);

  // 1. Remove MCP entry (only if it's ours).
  let mcpEntryRemoved = false;
  const existingCfg = await readJson(mcpConfigPath);
  if (existingCfg) {
    const servers = getMcpServersObject(existingCfg);
    if (TK_MCP_SERVER_NAME in servers) {
      const { [TK_MCP_SERVER_NAME]: _removed, ...rest } = servers;
      const nextCfg: Record<string, unknown> = {
        ...existingCfg,
        mcpServers: rest,
      };
      // If mcpServers is empty AND it was the only top-level key besides
      // ours, leave the file alone (don't create a near-empty file). Simpler:
      // always write back; Claude Code tolerates empty mcpServers.
      await writeJsonPreserving(mcpConfigPath, nextCfg);
      mcpEntryRemoved = true;
    }
  }

  // 2. Strip CLAUDE.md marked block.
  const cmdPath = claudeMdPath(input.workspaceRoot);
  let stripped = false;
  try {
    const existing = await fs.readFile(cmdPath, "utf8");
    const { stripped: next, hadBlock } = stripExistingBlock(existing);
    if (hadBlock) {
      // Clean up trailing whitespace.
      const trimmed = next.replace(/\s+$/, "") + "\n";
      // If the file is now effectively empty, delete it so we don't leave
      // a stub behind that wasn't there before connect.
      if (trimmed.trim().length === 0) {
        await fs.rm(cmdPath, { force: true });
      } else {
        await fs.writeFile(cmdPath, trimmed);
      }
      stripped = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return {
    ok: true,
    mcpConfigPath,
    mcpEntryRemoved,
    claudeMdPath: cmdPath,
    claudeMdStripped: stripped,
  };
}

export async function claudeCodeStatus(input: ClaudeCodeStatusInput): Promise<ClaudeCodeStatusResult> {
  const homeDir = input.homeDir ?? os.homedir();
  const globalPath = globalMcpPath(homeDir);
  const wsPath = workspaceMcpPath(input.workspaceRoot);
  const cmdPath = claudeMdPath(input.workspaceRoot);

  const [globalCfg, wsCfg] = await Promise.all([readJson(globalPath), readJson(wsPath)]);
  const connectedGlobal = Boolean(globalCfg && TK_MCP_SERVER_NAME in getMcpServersObject(globalCfg));
  const connectedWorkspace = Boolean(wsCfg && TK_MCP_SERVER_NAME in getMcpServersObject(wsCfg));

  let instructionsInClaudeMd = false;
  try {
    const content = await fs.readFile(cmdPath, "utf8");
    instructionsInClaudeMd = content.includes(TK_BEGIN_MARKER);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return {
    globalMcpConfigPath: globalPath,
    workspaceMcpConfigPath: wsPath,
    claudeMdPath: cmdPath,
    connectedGlobal,
    connectedWorkspace,
    instructionsInClaudeMd,
  };
}
