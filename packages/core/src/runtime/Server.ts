import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { explainRoute } from "../usecases/explainRoute.js";
import { buildCompressedContext } from "../usecases/buildCompressedContext.js";
import { compareCompressedContext } from "../usecases/compareCompressedContext.js";
import { readArtifact, writeArtifact } from "./contextArtifactStore.js";
import { readVerdict, writeVerdict, VerdictStoreError } from "./verdictStore.js";
import { forwardMessages, streamMessages, forwardCountTokens } from "./anthropicGateway.js";
import {
  buildContextPack,
  clearFileDigestCache,
  compressCommand,
  compressErrorLog,
  compressJson,
  compressTestOutput,
  getFileDigestCached,
  getFileDigestCacheStats,
  makeRefineCallback,
  summarizeGitDiff,
} from "../digest/index.js";
import { isProfileDisabled } from "../model/profileIdentity.js";
import {
  claudeCodeStatus,
  connectClaudeCode,
  disconnectClaudeCode,
  type ConnectScope,
  type InstructionsLevel,
} from "../usecases/connectClaudeCode.js";
import { chatWithClaude } from "../usecases/chatWithClaude.js";
import { listClaudeSessions } from "../usecases/listClaudeSessions.js";
import { readClaudeSession, ReadClaudeSessionError } from "../usecases/readClaudeSession.js";
import { computeTierkitMcpSavings, resolveSavingsBaseline } from "./tierkitSavings.js";
import * as savingsBroadcaster from "./savingsBroadcaster.js";
import { setActivityListener } from "../mcp/activityLog.js";
import type { TierkitConfig } from "../config/TierkitConfig.js";
import { checkCommand } from "../usecases/checkCommand.js";
import { checkPath } from "../usecases/checkPath.js";
import { redactSecrets } from "../security/SecretRedactor.js";
import { loadConfig } from "../config/loadConfig.js";
import { TIERKIT_VERSION } from "../version.js";
import { aggregateByProfile, readUsage, summarizeUsage } from "./usageLog.js";
import { checkBudget } from "./budget.js";
import { executeLlmCall, type LlmCallRequest } from "./proxy/llmCall.js";
import {
  startSession,
  getCurrentSession,
  advanceSession,
  approvePlan,
  abandonSession,
  SessionError,
} from "../usecases/session.js";
import { listModels } from "../usecases/listModels.js";
import { testModel, TestModelError } from "../usecases/testModel.js";
import { listPlugins } from "../usecases/listPlugins.js";
import { addProfile, removeProfile, updateProfileEnabled, ProfileCrudError, type ProfileScope } from "../usecases/profileCrud.js";
import { initProject } from "../usecases/initProject.js";
import { shutdownSpawnedOllama } from "./../model/providers/ollamaAutoLaunch.js";
import { handleOpenAIChatCompletions } from "./openaiCompat.js";
import { connectTool, listConnections, type ConnectableTool as ConnTool } from "../usecases/connectTool.js";
import { enablePlugin, disablePlugin, removePlugin, PluginLifecycleError } from "../usecases/pluginLifecycle.js";
import { installPlugin, PluginInstallError } from "../usecases/installPlugin.js";
import { PluginLoadError } from "../plugin/PluginLoader.js";
import { syncPlugins } from "../usecases/syncPlugins.js";
import { pluginNew, PluginNewError } from "../usecases/pluginNew.js";
import type { TierkitAdapter } from "../adapter/TierkitAdapter.js";
import type { Target } from "../plugin/PluginManifest.js";
import { GUI_HTML } from "./ui/gui.js";
import type { SessionState } from "./session/ExecutionSession.js";
import type { SecretsStore } from "../security/SecretsStore.js";
import {
  listPatchTickets,
  readPatchTicket,
  approvePatchTicket,
  rejectPatchTicket,
  InvalidPatchStateError,
} from "../index.js";

export interface ServerOptions {
  /** Project root the runtime operates on. */
  cwd: string;
  /** Bind address. Defaults to "127.0.0.1" via the caller. Never use 0.0.0.0 by default. */
  host: string;
  /** Port to bind. 0 = pick any free port. */
  port: number;
  /** Env to pass through to provider clients. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Export adapters by target. Used by `/v1/plugins/sync` to write rule/prompt files into
   * each connected coding agent's directory format. Without adapters provided, sync will
   * skip every target it doesn't have one for. The CLI and VS Code extension wire all
   * three (roo/cline/continue) here.
   */
  adapters?: Partial<Record<Target, TierkitAdapter>>;
  /**
   * Optional extra route handlers, evaluated BEFORE built-in routes. Lets higher-level
   * packages (`@tierkit/agent`, VS Code extension) plug in `/v1/agent/run` etc. without
   * the core having to depend on them. Each handler inspects the request and either
   * writes a response (returning true) or skips (returning false, in which case the next
   * handler — and eventually the built-in dispatch — gets a try).
   */
  routeExtensions?: RouteExtension[];
  /**
   * Optional default plugins to install on first run. The server checks the registry at
   * startup: if no plugin has ever been installed (registry empty or missing), every entry
   * here gets installed in order. Items with `autoEnable: true` are then enabled (with
   * auto-`initProject` if no `tierkit.config.json` exists yet). Items without it are
   * installed-but-disabled, so the user can flip them on later via the GUI toggle.
   *
   * Once any registry entry exists, this option is silently ignored — the user's prior
   * choices (uninstalled, disabled, swapped) are preserved across daemon restarts.
   *
   * Typical use: the VS Code extension passes all four bundled `superpowers-*` samples
   * and marks `superpowers-guided` as the only one to auto-enable, so users get every
   * preset preinstalled and the recommended one active by default.
   */
  bootstrapPlugins?: Array<{
    /** Absolute path to a plugin directory. Passed verbatim to `installPlugin`. */
    path: string;
    /** When true, enable this plugin after install. Default false (install only). */
    autoEnable?: boolean;
  }>;
  /**
   * Optional store for runtime-managed API keys (read/written via /v1/secrets).
   * The daemon caller is expected to call `secrets.loadIntoEnv()` BEFORE startServer,
   * so providers see the keys via process.env. Without this field, /v1/secrets returns 501.
   */
  secrets?: SecretsStore;
  /**
   * Override `os.homedir()` for Claude's project-session lookup
   * (~/.claude/projects/). Primarily used by tests so they don't have to
   * mutate `process.env.HOME`. Production callers leave this undefined.
   */
  homeDir?: string;
}

export interface RouteExtension {
  /** Human-readable label for diagnostics. */
  name: string;
  /** Return true if this handler took the request; false to fall through. */
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<boolean>;
}

export interface RunningServer {
  address: string;
  port: number;
  close(): Promise<void>;
}

const VERSION = TIERKIT_VERSION;

const ARTIFACTS_SUBDIR = ".tierkit/runtime/context-artifacts";
const RECENT_CAP = 20;
const CTX_ID_RE = /^ctx_[a-f0-9]{10}$/;

async function listRecentContexts(workspaceRoot: string) {
  const dir = path.join(workspaceRoot, ARTIFACTS_SUBDIR);
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch { return { recent: [], totalCount: 0 }; }

  type Entry = {
    id: string;
    createdAt: string;
    task: string;
    candidatesCount: number;
    estimatedBaselineInputTokens: number;
    estimatedCompressedInputTokens: number;
    hasCompare: boolean;
    hasVerdict: boolean;
  };
  const entries: Entry[] = [];

  for (const name of names) {
    if (!CTX_ID_RE.test(name)) continue;
    try {
      const { artifact } = await readArtifact(workspaceRoot, name);
      const verdict = await readVerdict(workspaceRoot, name);
      entries.push({
        id: name,
        createdAt: artifact.createdAt,
        task: artifact.task.replace(/\s+/g, " ").slice(0, 120),
        candidatesCount: artifact.candidates.length,
        estimatedBaselineInputTokens: artifact.estimatedBaselineInputTokens,
        estimatedCompressedInputTokens: artifact.estimatedCompressedInputTokens,
        hasCompare: artifact.compare !== undefined,
        hasVerdict: verdict !== null,
      });
    } catch (err) {
      console.warn(`Warning: skipping ${name} in recent list: ${(err as Error).message ?? err}`);
      // malformed — excluded from both recent[] and totalCount
    }
  }

  entries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return { recent: entries.slice(0, RECENT_CAP), totalCount: entries.length };
}

/**
 * Start the Tierkit runtime HTTP daemon. Returns once the server is listening.
 *
 * Routes (all under /v1):
 *   GET  /v1/health                       → { ok: true, version, cwd }
 *   POST /v1/route        body: ExplainRouteUsecaseInput → route decision
 *   POST /v1/check/command body: { command }
 *   POST /v1/check/path    body: { path }
 *   POST /v1/redact        body: { text }                → { text, hits }
 *   POST /v1/llm-call      body: LlmCallRequest          → LlmCallResult (proxied; logs usage)
 *   GET  /v1/usage[?since=ISO]                            → { records, summary }
 *   GET  /v1/budget                                       → BudgetCheckResult
 *
 * The server is bound to `host` only (default localhost). It performs no authentication —
 * security relies on the loopback bind. Do not change `host` to a non-loopback address
 * without adding authentication first.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);

  let cachedConfig: TierkitConfig | null = null;
  // Pre-populate cachedConfig so the first SSE subscriber gets a real snapshot
  // without waiting for a GET /v1/tierkit/savings/today poll. Skipped under
  // TIERKIT_NO_BUNDLED_DEFAULTS=1 (test runs) to avoid triggering loadConfig
  // migrations before test route handlers do their own first call, which would
  // change the on-disk config and alter subsequent loadConfig results.
  if (process.env.TIERKIT_NO_BUNDLED_DEFAULTS !== "1") {
    try { cachedConfig = (await loadConfig(opts.cwd)).config; }
    catch { /* config not yet present — broadcaster will see null and skip */ }
  }

  // Tracks artifacts that currently have an in-flight compare. Per-daemon
  // (not module-global) so tests with independent daemons don't share state.
  const runningCompares = new Set<string>();

  // v0.20.7: Extension registers its bundled-CLI path + Electron-as-Node
  // binary here on startup (POST /v1/claude-code/host-info). The Claude Code
  // connect flow then uses these so the MCP entry doesn't depend on a global
  // `tierkit` install. Per-daemon state.
  const hostInfo: { cliPath?: string; nodeBinary?: string } = {};

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = (req.method ?? "GET").toUpperCase();
      const route = `${method} ${url.pathname}`;

      // ── CORS ────────────────────────────────────────────────────────────────
      // Daemon is loopback-only (127.0.0.1), so allowing any origin doesn't widen the
      // attack surface — anyone who can already reach the daemon can already do anything
      // it accepts. Without these headers, browser fetches from sandboxed contexts
      // (VS Code webviews use the `vscode-webview://<id>` scheme, which the browser
      // treats as cross-origin relative to `http://localhost:4101`) get blocked by CORS
      // before the request even leaves the page.
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, PATCH, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type, authorization");
      res.setHeader("access-control-max-age", "600");
      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      // ── Route extensions ────────────────────────────────────────────────────
      // Externally-injected handlers (e.g. @tierkit/agent's /v1/agent/run) get first
      // look. If any handler claims the request (returns true), we're done — it has
      // already written the response. Otherwise we fall through to built-in routes.
      if (opts.routeExtensions && opts.routeExtensions.length > 0) {
        for (const ext of opts.routeExtensions) {
          const claimed = await ext.handle(req, res, { cwd: opts.cwd, env });
          if (claimed) return;
        }
      }

      if (route === "GET /v1/health") {
        return sendJson(res, 200, { ok: true, version: VERSION, cwd: opts.cwd });
      }

      if (route === "POST /v1/route") {
        const body = await readJsonBody<{
          task: string;
          filesTouchedEstimate?: number;
          involvesSecrets?: boolean;
          involvesProductionInfra?: boolean;
        }>(req);
        if (!body || typeof body.task !== "string") {
          return sendJson(res, 400, { error: "request must be { task: string }" });
        }
        const result = await explainRoute({
          cwd: opts.cwd,
          task: body.task,
          ...(body.filesTouchedEstimate !== undefined
            ? { filesTouchedEstimate: body.filesTouchedEstimate }
            : {}),
          ...(body.involvesSecrets !== undefined ? { involvesSecrets: body.involvesSecrets } : {}),
          ...(body.involvesProductionInfra !== undefined
            ? { involvesProductionInfra: body.involvesProductionInfra }
            : {}),
        });
        return sendJson(res, 200, result);
      }

      if (route === "POST /v1/context/build") {
        const body = await readJsonBody<{
          task?: unknown;
          budget?: unknown;
          extraIgnoreGlobs?: unknown;
        }>(req);
        if (!body || typeof body.task !== "string") {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "task is required" });
        }
        if (body.extraIgnoreGlobs !== undefined && !Array.isArray(body.extraIgnoreGlobs)) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "extraIgnoreGlobs must be an array of strings" });
        }
        const result = await buildCompressedContext({
          task: body.task,
          workspaceRoot: opts.cwd,
          ...(body.budget ? { budget: body.budget as never } : {}),
          ...(body.extraIgnoreGlobs ? { extraIgnoreGlobs: body.extraIgnoreGlobs as string[] } : {}),
        });
        if (!result.ok) {
          return sendJson(res, 400, { ok: false, code: result.code, message: result.message });
        }
        const { id } = await writeArtifact(opts.cwd, result.artifact, result.promptMd);
        const finalized = { ...result.artifact, id };
        return sendJson(res, 200, {
          ok: true,
          artifact: finalized,
          promptMdWorkspacePath: path.posix.join(".tierkit/runtime/context-artifacts", id, "prompt.md"),
        });
      }

      // v0.18 context-gateway digest endpoints. Each is a thin wrapper around the
      // corresponding @tierkit/core function. Inputs are plain JSON; outputs are
      // the digest object (no envelope wrapper — that's MCP's job). The daemon
      // does not persist these to the artifact store; callers persist if they want.
      if (route === "POST /v1/digest/command") {
        const body = await readJsonBody<{
          command?: unknown;
          refine?: unknown;
        }>(req);
        if (!body || typeof body.command !== "string" || body.command.length === 0) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "command is required" });
        }
        // Optional refine: { profileId: "..." } looks up a local profile and
        // wires its chat client as the LLM-refinement step inside compressCommand.
        let refineOpt: { refine: (p: string) => Promise<string>; provider: "ollama"; model: string } | undefined;
        if (body.refine && typeof body.refine === "object") {
          const profileId = (body.refine as { profileId?: unknown }).profileId;
          if (typeof profileId !== "string") {
            return sendJson(res, 400, { ok: false, code: "bad-request", message: "refine.profileId must be a string" });
          }
          const cfg = await loadConfig(opts.cwd);
          const profile = cfg.config.modelProfiles[profileId];
          if (!profile) {
            return sendJson(res, 404, { ok: false, code: "profile-not-found", message: `model profile ${profileId} not found` });
          }
          if (isProfileDisabled(cfg.config, profileId)) {
            return sendJson(res, 400, { ok: false, code: "profile-disabled", message: `model profile ${profileId} is disabled` });
          }
          refineOpt = {
            refine: makeRefineCallback(profile),
            provider: "ollama",
            model: profile.model,
          };
        }
        const digest = await compressCommand(body.command, refineOpt);
        return sendJson(res, 200, { ok: true, digest });
      }

      if (route === "POST /v1/digest/error") {
        const body = await readJsonBody<{ log?: unknown }>(req);
        if (!body || typeof body.log !== "string" || body.log.length === 0) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "log is required" });
        }
        const digest = compressErrorLog(body.log);
        return sendJson(res, 200, { ok: true, digest });
      }

      if (route === "POST /v1/digest/test") {
        const body = await readJsonBody<{ output?: unknown }>(req);
        if (!body || typeof body.output !== "string" || body.output.length === 0) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "output is required" });
        }
        const digest = compressTestOutput(body.output);
        return sendJson(res, 200, { ok: true, digest });
      }

      if (route === "POST /v1/digest/json") {
        const body = await readJsonBody<{ json?: unknown }>(req);
        if (!body || typeof body.json !== "string" || body.json.length === 0) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "json is required" });
        }
        const digest = compressJson(body.json);
        return sendJson(res, 200, { ok: true, digest });
      }

      if (route === "POST /v1/digest/file") {
        const body = await readJsonBody<{ path?: unknown; forceRefresh?: unknown }>(req);
        if (!body || typeof body.path !== "string" || body.path.length === 0) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "path is required" });
        }
        // Path must resolve under the workspace; reject ../ escapes before reading.
        const candidate = path.resolve(opts.cwd, body.path);
        const rel = path.relative(opts.cwd, candidate);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return sendJson(res, 400, { ok: false, code: "outside-workspace", message: `path ${body.path} resolves outside workspaceRoot` });
        }
        const digest = await getFileDigestCached(body.path, {
          workspaceRoot: opts.cwd,
          forceRefresh: body.forceRefresh === true,
        });
        return sendJson(res, 200, { ok: true, digest });
      }

      if (route === "POST /v1/digest/diff") {
        const body = await readJsonBody<{ staged?: unknown }>(req) ?? {};
        const digest = await summarizeGitDiff(opts.cwd, {
          staged: body.staged === true,
        });
        return sendJson(res, 200, { ok: true, digest });
      }

      if (route === "GET /v1/digest/cache") {
        const stats = await getFileDigestCacheStats(opts.cwd);
        return sendJson(res, 200, { ok: true, stats });
      }

      if (route === "POST /v1/digest/cache/clear") {
        const result = await clearFileDigestCache(opts.cwd);
        return sendJson(res, 200, { ok: true, ...result });
      }

      // v0.20: Claude Code auto-wire (MCP entry + CLAUDE.md instruction block)
      if (route === "GET /v1/claude-code/status") {
        const status = await claudeCodeStatus({ workspaceRoot: opts.cwd });
        return sendJson(res, 200, { ok: true, status });
      }

      // v0.20.7: Extension registers its bundled-CLI path + Electron path here
      // on startup. Subsequent /v1/claude-code/connect calls use these so the
      // MCP entry doesn't depend on a global `tierkit` install.
      if (route === "POST /v1/claude-code/host-info") {
        const body = await readJsonBody<{ cliPath?: unknown; nodeBinary?: unknown }>(req) ?? {};
        if (typeof body.cliPath === "string") hostInfo.cliPath = body.cliPath;
        if (typeof body.nodeBinary === "string") hostInfo.nodeBinary = body.nodeBinary;

        // v0.22.5: auto-heal stale cliPath in existing tierkit MCP entries.
        // When VS Code auto-updates the extension, context.extensionPath
        // changes (…/leesiwal.tierkit-vscode-0.22.X/…) and the entry in
        // .mcp.json / ~/.claude.json is left pointing at the old folder.
        // Without this hook the user has to manually click Connect again.
        //
        // `onlyIfAlreadyConnected: true` guarantees we never create new
        // entries — users who never opted into MCP wire-up stay untouched.
        const autoHealed = { workspace: false, global: false };
        if (hostInfo.cliPath) {
          const common = {
            workspaceRoot: opts.cwd,
            instructionsLevel: "none" as InstructionsLevel,
            cliPath: hostInfo.cliPath,
            ...(hostInfo.nodeBinary ? { nodeBinary: hostInfo.nodeBinary } : {}),
            ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
            onlyIfAlreadyConnected: true,
          };
          for (const scope of ["workspace", "global"] as const) {
            try {
              const r = await connectClaudeCode({ ...common, scope });
              autoHealed[scope] = !r.skipped;
            } catch (err) {
              console.error(`[tierkit] host-info auto-heal (${scope}) failed:`, err);
            }
          }
        }
        return sendJson(res, 200, { ok: true, hostInfo, autoHealed });
      }
      if (route === "POST /v1/claude-code/connect") {
        const body = await readJsonBody<{
          scope?: unknown;
          instructionsLevel?: unknown;
          cliPath?: unknown;
          nodeBinary?: unknown;
        }>(req) ?? {};
        const scope = body.scope === "global" ? "global" : "workspace";
        const lvl = body.instructionsLevel;
        const instructionsLevel: InstructionsLevel =
          lvl === "none" || lvl === "light" || lvl === "full" ? lvl : "light";
        // v0.20.7: Extension hands us bundled-CLI path + Electron path so the
        // MCP spawn never depends on a global `tierkit` install. Fall back to
        // the hostInfo registered at startup so the JS layer doesn't have to
        // pass paths on every call.
        const cliPath = (typeof body.cliPath === "string" && body.cliPath.length > 0)
          ? body.cliPath
          : hostInfo.cliPath;
        const nodeBinary = (typeof body.nodeBinary === "string" && body.nodeBinary.length > 0)
          ? body.nodeBinary
          : hostInfo.nodeBinary;
        try {
          const result = await connectClaudeCode({
            workspaceRoot: opts.cwd,
            scope: scope as ConnectScope,
            instructionsLevel,
            ...(cliPath ? { cliPath } : {}),
            ...(nodeBinary ? { nodeBinary } : {}),
          });
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 500, { ok: false, code: "connect-failed", message: (err as Error).message });
        }
      }
      if (route === "POST /v1/claude-code/disconnect") {
        const body = await readJsonBody<{ scope?: unknown }>(req) ?? {};
        const scope = body.scope === "global" ? "global" : "workspace";
        try {
          const result = await disconnectClaudeCode({
            workspaceRoot: opts.cwd,
            scope: scope as ConnectScope,
          });
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 500, { ok: false, code: "disconnect-failed", message: (err as Error).message });
        }
      }

      // v0.22: List all Claude Code sessions for the current workspace.
      if (route === "GET /v1/claude-code/sessions") {
        try {
          const r = await listClaudeSessions({
            cwd: opts.cwd,
            ...(opts.homeDir ? { homeDirOverride: opts.homeDir } : {}),
          });
          return sendJson(res, 200, { ok: true, sessions: r.sessions });
        } catch (err) {
          return sendJson(res, 500, { ok: false, code: "scan-failed", message: (err as Error).message });
        }
      }

      // v0.22: Read one Claude Code session by id.
      if (method === "GET" && url.pathname.startsWith("/v1/claude-code/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/claude-code/sessions/".length));
        try {
          const r = await readClaudeSession({
            cwd: opts.cwd,
            id,
            ...(opts.homeDir ? { homeDirOverride: opts.homeDir } : {}),
          });
          return sendJson(res, 200, { ok: true, id: r.id, messages: r.messages });
        } catch (err) {
          if (err instanceof ReadClaudeSessionError) {
            const status = err.code === "bad-id" ? 400 : 404;
            return sendJson(res, status, { ok: false, code: err.code, message: err.message });
          }
          return sendJson(res, 500, { ok: false, code: "read-failed", message: (err as Error).message });
        }
      }

      // v0.21: Tierkit Chat as a streaming proxy over the claude CLI. The
      // webview POSTs the user's message + optional sessionId; we spawn
      // `claude -p` and forward its stream-json events as SSE so the webview
      // renders Claude's response in real time. The webview is now the actual
      // chat surface — no clipboard, no ⌘V, no Claude Code sidebar.
      if (route === "POST /v1/claude-code/chat") {
        const body = await readJsonBody<{
          message?: unknown;
          sessionId?: unknown;
          permissionMode?: unknown;
        }>(req) ?? {};
        if (typeof body.message !== "string" || body.message.length === 0) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "message is required" });
        }
        const sessionId = typeof body.sessionId === "string" && body.sessionId.length > 0
          ? body.sessionId
          : undefined;
        // v0.21.3: forward permissionMode through to chatWithClaude. Validate
        // against the closed enum so a malformed client doesn't push an
        // arbitrary string into claude's CLI args.
        const permModeRaw = body.permissionMode;
        const validModes = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;
        const permissionMode = typeof permModeRaw === "string" && (validModes as readonly string[]).includes(permModeRaw)
          ? (permModeRaw as typeof validModes[number])
          : undefined;

        // Switch to SSE.
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.flushHeaders?.();

        // v0.21.2: do NOT emit "event:" lines. The VS Code webview streamProxy
        // only forwards blocks whose first line starts with "data:" — any
        // block starting with "event: foo\ndata: ..." gets dropped silently,
        // which is why the webview saw zero chunks in 0.21.0/0.21.1 and
        // hung on "thinking…". The event type lives inside the JSON payload
        // (every ChatEvent has a .type field) and the webview dispatches on
        // payload.type, so the SSE event-name line is redundant.
        const writeData = (payload: unknown) => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          } catch { /* socket closed */ }
        };
        const keepalive = setInterval(() => {
          if (res.writableEnded || res.destroyed) return;
          try { res.write(":\n\n"); } catch { /* socket closed */ }
        }, 15_000);

        // Kill the claude subprocess if the client aborts the SSE stream.
        const ac = new AbortController();
        req.on("close", () => ac.abort());

        try {
          for await (const evt of chatWithClaude({
            message: body.message,
            cwd: opts.cwd,
            signal: ac.signal,
            ...(sessionId ? { sessionId } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          })) {
            writeData(evt);
          }
          writeData({ type: "done", ok: true });
        } catch (err) {
          writeData({ type: "error", code: "stream-error", message: (err as Error).message });
        } finally {
          clearInterval(keepalive);
          if (!res.writableEnded) res.end();
        }
        return;
      }

      if (route === "POST /v1/context/pack") {
        const body = await readJsonBody<{
          command?: unknown;
          files?: unknown;
          includeDiff?: unknown;
          stagedDiff?: unknown;
          errorLog?: unknown;
          testOutput?: unknown;
          jsonInput?: unknown;
          rawContext?: unknown;
        }>(req) ?? {};
        const files: string[] = Array.isArray(body.files)
          ? body.files.filter((f): f is string => typeof f === "string" && f.length > 0)
          : [];
        for (const f of files) {
          const candidate = path.resolve(opts.cwd, f);
          const rel = path.relative(opts.cwd, candidate);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            return sendJson(res, 400, { ok: false, code: "outside-workspace", message: `path ${f} resolves outside workspaceRoot` });
          }
        }
        const pack = await buildContextPack({
          workspaceRoot: opts.cwd,
          command: typeof body.command === "string" ? body.command : undefined,
          files: files.length > 0 ? files : undefined,
          includeDiff: body.includeDiff === true,
          stagedDiff: body.stagedDiff === true,
          errorLog: typeof body.errorLog === "string" ? body.errorLog : undefined,
          testOutput: typeof body.testOutput === "string" ? body.testOutput : undefined,
          jsonInput: typeof body.jsonInput === "string" ? body.jsonInput : undefined,
          rawContext: typeof body.rawContext === "string" ? body.rawContext : undefined,
        });
        return sendJson(res, 200, { ok: true, pack });
      }

      if (route === "GET /v1/context/recent") {
        const { recent, totalCount } = await listRecentContexts(opts.cwd);
        return sendJson(res, 200, { ok: true, recent, totalCount });
      }

      if (method === "GET" && url.pathname.startsWith("/v1/context/") && url.pathname !== "/v1/context/recent") {
        const idMatch = url.pathname.match(/^\/v1\/context\/(ctx_[a-f0-9]{10})$/);
        if (idMatch) {
          const id = idMatch[1]!;
          try {
            const { artifact } = await readArtifact(opts.cwd, id);
            const verdict = await readVerdict(opts.cwd, id);
            return sendJson(res, 200, { ok: true, artifact, verdict });
          } catch (err) {
            const e = err as { code?: string; message?: string };
            if (e.code === "not-found") {
              return sendJson(res, 404, { ok: false, code: "not-found", message: e.message ?? `artifact '${id}' not found` });
            }
            throw err;
          }
        }
        // Malformed id (doesn't match ctx_[a-f0-9]{10}) → fall through to other route checks.
      }

      if (method === "POST" && url.pathname.startsWith("/v1/context/") && url.pathname.endsWith("/verdict")) {
        const idMatch = url.pathname.match(/^\/v1\/context\/(ctx_[a-f0-9]{10})\/verdict$/);
        if (!idMatch) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "invalid context id in path" });
        }
        const id = idMatch[1]!;
        const body = await readJsonBody<{ qualityVerdict?: unknown; missingContext?: unknown; notes?: unknown }>(req);
        if (!body || typeof body.qualityVerdict !== "string") {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "qualityVerdict is required" });
        }
        try {
          const verdict = await writeVerdict(opts.cwd, id, {
            qualityVerdict: body.qualityVerdict as never,
            ...(body.missingContext !== undefined ? { missingContext: body.missingContext as boolean } : {}),
            ...(body.notes !== undefined ? { notes: body.notes as string } : {}),
          });
          return sendJson(res, 200, { ok: true, verdict });
        } catch (err) {
          if (err instanceof VerdictStoreError) {
            const status = err.code === "artifact-not-found" ? 404
                         : err.code === "compare-not-run" ? 409
                         : 400;
            return sendJson(res, status, { ok: false, code: err.code, message: err.message });
          }
          // zod validation error (e.g. notes too long, bad enum) → 400
          if ((err as Error).name === "ZodError" || (err as { issues?: unknown }).issues) {
            return sendJson(res, 400, { ok: false, code: "bad-request", message: (err as Error).message });
          }
          throw err;
        }
      }

      if (method === "POST" && url.pathname.startsWith("/v1/context/") && url.pathname.endsWith("/compare")) {
        const idMatch = url.pathname.match(/^\/v1\/context\/(ctx_[a-f0-9]{10})\/compare$/);
        if (!idMatch) {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "invalid context id in path" });
        }
        const id = idMatch[1]!;
        const body = await readJsonBody<{
          profileId?: unknown;
          confirm?: unknown;
          mode?: unknown;
        }>(req);
        if (!body || typeof body.profileId !== "string") {
          return sendJson(res, 400, { ok: false, code: "bad-request", message: "profileId is required" });
        }
        // 1. Artifact existence
        let artifact;
        try {
          ({ artifact } = await readArtifact(opts.cwd, id));
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === "not-found") {
            return sendJson(res, 404, { ok: false, code: "not-found", message: e.message ?? `artifact '${id}' not found` });
          }
          throw err;
        }

        // 2. Profile existence
        const cfg = (await loadConfig(opts.cwd)).config;
        const profile = cfg.modelProfiles[body.profileId];
        if (!profile) {
          return sendJson(res, 400, {
            ok: false, code: "bad-request",
            message: `unknown profile "${body.profileId}"`,
          });
        }

        // 3. confirm: true precondition
        if (body.confirm !== true) {
          const estBaseline = artifact.estimatedBaselineInputTokens;
          const estCompressed = artifact.estimatedCompressedInputTokens;
          const inputCostPerM =
            profile.cost?.type === "per-token" ? profile.cost.inputUsdPerMillion : null;
          return sendJson(res, 412, {
            ok: false,
            code: "confirm-required",
            message: "compare runs 2 paid model calls; pass { confirm: true } to proceed",
            estimated: {
              baselineInputTokens: estBaseline,
              compressedInputTokens: estCompressed,
              baselineInputCostUsd: inputCostPerM !== null ? (estBaseline / 1_000_000) * inputCostPerM : null,
              compressedInputCostUsd: inputCostPerM !== null ? (estCompressed / 1_000_000) * inputCostPerM : null,
              profileId: body.profileId,
            },
          });
        }

        // 4. compare-already-running dedup
        if (runningCompares.has(id)) {
          return sendJson(res, 409, {
            ok: false,
            code: "compare-already-running",
            message: `another compare is already running for ${id}`,
          });
        }

        // 5. Switch to SSE — from here on, errors become SSE error events.
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.flushHeaders?.();

        runningCompares.add(id);
        const writeEvent = (eventName: string, payload: unknown) => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.write(`event: ${eventName}\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          } catch {
            // socket closed during write — abort future writes by returning silently
          }
        };
        // Keepalive every 15s
        const keepalive = setInterval(() => {
          if (res.writableEnded || res.destroyed) return;
          try { res.write(":\n\n"); } catch { /* socket closed */ }
        }, 15_000);

        // Best-effort: abort on client disconnect. compareCompressedContext does not
        // currently accept an AbortSignal, so this controller is only used as a signal
        // for future wiring + to surface disconnect intent in logs.
        const abortController = new AbortController();
        req.on("close", () => {
          abortController.abort();
        });

        try {
          const result = await compareCompressedContext({
            workspaceRoot: opts.cwd,
            id,
            profileId: body.profileId,
            ...(typeof body.mode === "string" ? { mode: body.mode as "plan" | "review" | "execute" } : {}),
            onPhase: (phase) => {
              writeEvent("phase", { phase });
            },
            onBaselineDelta: (text) => { writeEvent("delta", { side: "baseline", text }); },
            onCompressedDelta: (text) => { writeEvent("delta", { side: "compressed", text }); },
          });
          if (!result.ok) {
            const side = result.phase === "baseline" || result.phase === "compressed" ? result.phase : undefined;
            writeEvent("error", { code: result.code, message: result.message, ...(side ? { side } : {}) });
            return;
          }
          // Emit side-result for each side from the compare result.
          for (const side of ["baseline", "compressed"] as const) {
            const sr = result.compare[side];
            writeEvent("side-result", {
              side,
              ...(sr.actualInputTokens !== undefined ? { actualInputTokens: sr.actualInputTokens } : {}),
              ...(sr.actualOutputTokens !== undefined ? { actualOutputTokens: sr.actualOutputTokens } : {}),
              ...(sr.actualCostUsd !== undefined ? { actualCostUsd: sr.actualCostUsd } : {}),
              ...(sr.latencyMs !== undefined ? { latencyMs: sr.latencyMs } : {}),
              ...(sr.failureCode !== undefined ? { failureCode: sr.failureCode } : {}),
            });
          }
          writeEvent("compare-done", { compare: result.compare, artifact: result.artifact });
        } catch (err) {
          const e = err as Error;
          writeEvent("error", { code: "unexpected", message: e.message ?? String(err) });
        } finally {
          clearInterval(keepalive);
          runningCompares.delete(id);
          if (!res.writableEnded) {
            try { res.end(); } catch { /* socket closed */ }
          }
        }
        return;
      }

      if (route === "POST /v1/check/command") {
        const body = await readJsonBody<{ command: string }>(req);
        if (!body || typeof body.command !== "string") {
          return sendJson(res, 400, { error: "request must be { command: string }" });
        }
        const result = await checkCommand({ command: body.command });
        return sendJson(res, 200, result);
      }

      if (route === "POST /v1/check/path") {
        const body = await readJsonBody<{ path: string }>(req);
        if (!body || typeof body.path !== "string") {
          return sendJson(res, 400, { error: "request must be { path: string }" });
        }
        const result = await checkPath({ pathToCheck: body.path });
        return sendJson(res, 200, result);
      }

      if (route === "POST /v1/redact") {
        const body = await readJsonBody<{ text: string }>(req);
        if (!body || typeof body.text !== "string") {
          return sendJson(res, 400, { error: "request must be { text: string }" });
        }
        const result = redactSecrets(body.text);
        return sendJson(res, 200, result);
      }

      if (route === "POST /v1/llm-call") {
        const body = await readJsonBody<LlmCallRequest>(req);
        if (!body || typeof body.profileId !== "string" || !Array.isArray(body.messages)) {
          return sendJson(res, 400, {
            error: "request must be { profileId: string, messages: ChatMessage[] }",
          });
        }
        const result = await executeLlmCall(body, { cwd: opts.cwd, env });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (route === "GET /v1/usage") {
        const cfg = await loadConfig(opts.cwd);
        const usagePath = path.join(opts.cwd, cfg.config.runtime.dataDir, "usage.jsonl");
        const records = await readUsage(usagePath);
        const since = url.searchParams.get("since");
        const summary = summarizeUsage(records, since ? new Date(since) : undefined);
        return sendJson(res, 200, {
          records: records.slice(-200),
          summary: serializeSummary(summary),
          profiles: aggregateByProfile(records, new Date()),
        });
      }

      if (route === "GET /v1/budget") {
        const cfg = await loadConfig(opts.cwd);
        const usagePath = path.join(opts.cwd, cfg.config.runtime.dataDir, "usage.jsonl");
        const result = await checkBudget(usagePath, cfg.config.budget);
        return sendJson(res, 200, result);
      }

      // v0.17: today's routing-savings summary, used by the GUI Savings card.
      // Resolves baselineProfileId from config.routingBaseline (defaulting to
      // "claudeCode"). When the resolved profile has no cost data (e.g. the
      // bundled claudeCode profile uses flat-rate pricing without per-token
      // numbers), v0.21.6 picks the most representative priced profile of
      // the SAME provider family as the requested baseline. So when the user
      // is running Claude Code (default baseline = "claudeCode" → flat-rate),
      // we fall back to a Claude-family priced profile (claudeSonnet, etc.) —
      // NOT to gpt-4o just because it happens to have the highest
      // inputUsdPerMillion. Otherwise savings get computed against the wrong
      // model and the dashboard misleads.
      // v0.21.7: MCP-driven savings. Counts today's tierkit.* compression
      // tool calls and converts savedTokens to USD using the baseline
      // profile's input cost-per-million. This is the metric that actually
      // updates when the user chats with Claude through Tierkit Chat.
      if (route === "GET /v1/tierkit/savings/today") {
        const cfg = await loadConfig(opts.cwd);
        cachedConfig = cfg.config;
        const { baselineId, baseProfile, inputUsdPerMillion } = resolveSavingsBaseline(cfg.config);
        const summary = await computeTierkitMcpSavings(
          opts.cwd,
          inputUsdPerMillion,
          opts.homeDir ? { homeDirOverride: opts.homeDir } : {},
        );
        return sendJson(res, 200, {
          ok: true,
          baselineProfileId: baselineId,
          baselineProvider: baseProfile?.provider,
          inputUsdPerMillion,
          ...summary,
        });
      }

      if (route === "GET /v1/tierkit/savings/stream") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.flushHeaders?.();
        // Refresh cachedConfig on each new subscriber so the initial snapshot
        // is based on the latest on-disk config even in test environments where
        // the preload was skipped.
        try { cachedConfig = (await loadConfig(opts.cwd)).config; } catch { /* leave as-is */ }
        await savingsBroadcaster.subscribe(res, opts.cwd);
        req.on("close", () => {
          try { res.end(); } catch { /* already closed */ }
        });
        return;
      }

      if (route === "GET /v1/savings/today") {
        const { computeRoutingSavings } = await import("./routingSavings.js");
        const cfg = await loadConfig(opts.cwd);
        const profiles = cfg.config.modelProfiles ?? {};
        const requestedId = cfg.config.routingBaseline ?? "claudeCode";
        let baselineId = requestedId;
        let profile = profiles[baselineId];
        let autoFallback: { from: string; to: string } | undefined;

        // Heuristic: which provider family does the requested baseline belong to?
        // We use this to pick a same-family priced fallback before falling back
        // to other families.
        const claudeProviders = new Set(["anthropic", "claude-code"]);
        const openaiProviders = new Set(["openai", "openai-compatible"]);
        const requestedProvider = profile?.provider ?? "claude-code";
        const requestedFamily =
          claudeProviders.has(requestedProvider) ? "claude"
          : openaiProviders.has(requestedProvider) ? "openai"
          : "other";

        function familyOf(p: { provider?: string } | undefined): "claude" | "openai" | "other" {
          const prov = p?.provider ?? "";
          if (claudeProviders.has(prov)) return "claude";
          if (openaiProviders.has(prov)) return "openai";
          return "other";
        }

        // If the requested baseline lacks per-token cost data, pick the most
        // expensive priced profile in the same provider family first; only
        // fall back to other families if no same-family priced profile exists.
        if (!profile || !profile.cost || profile.cost.type !== "per-token") {
          const priced = Object.entries(profiles)
            .filter(([, p]) => p?.cost?.type === "per-token" && (p.kind === "public-cloud" || p.kind === "private-remote"));
          // Sort: same-family first, then by descending inputUsdPerMillion.
          priced.sort(([, a], [, b]) => {
            const af = familyOf(a) === requestedFamily ? 0 : 1;
            const bf = familyOf(b) === requestedFamily ? 0 : 1;
            if (af !== bf) return af - bf;
            const ac = (a.cost as { inputUsdPerMillion?: number }).inputUsdPerMillion ?? 0;
            const bc = (b.cost as { inputUsdPerMillion?: number }).inputUsdPerMillion ?? 0;
            return bc - ac;
          });
          const candidate = priced[0];
          if (candidate) {
            autoFallback = { from: requestedId, to: candidate[0] };
            baselineId = candidate[0];
            profile = candidate[1];
          }
        }

        const windowStart = new Date();
        windowStart.setUTCHours(0, 0, 0, 0);

        if (!profile || !profile.cost) {
          return sendJson(res, 200, {
            baselineConfigured: false,
            baselineProfileId: baselineId,
            reason: profile ? "no-cost-data" : "profile-missing",
            windowStart: windowStart.toISOString(),
          });
        }

        const usagePath = path.join(opts.cwd, cfg.config.runtime.dataDir, "usage.jsonl");
        const records = await readUsage(usagePath);
        const summary = computeRoutingSavings(records, profile, windowStart);
        return sendJson(res, 200, {
          baselineConfigured: true,
          ...summary,
          ...(autoFallback ? { autoFallback } : {}),
        });
      }

      // ── v1.5: session + models/plugins read endpoints (used by the GUI + SDK) ──
      if (route === "GET /v1/session") {
        const r = await getCurrentSession({ cwd: opts.cwd });
        return sendJson(res, 200, {
          freedom: r.freedom,
          session: r.session ?? null,
        });
      }

      if (route === "POST /v1/session/start") {
        const body = await readJsonBody<{ task: string }>(req);
        if (!body || typeof body.task !== "string" || body.task.length === 0) {
          return sendJson(res, 400, { error: "request must be { task: string }" });
        }
        const r = await startSession({ cwd: opts.cwd, task: body.task });
        return sendJson(res, 200, r);
      }

      if (route === "POST /v1/session/advance") {
        const body = await readJsonBody<{ toState: SessionState; reason?: string }>(req);
        if (!body || typeof body.toState !== "string") {
          return sendJson(res, 400, { error: "request must be { toState: SessionState }" });
        }
        try {
          const s = await advanceSession({
            cwd: opts.cwd,
            toState: body.toState,
            ...(body.reason ? { reason: body.reason } : {}),
          });
          return sendJson(res, 200, s);
        } catch (err) {
          if (err instanceof SessionError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      if (route === "POST /v1/session/approve-plan") {
        try {
          const s = await approvePlan({ cwd: opts.cwd });
          return sendJson(res, 200, s);
        } catch (err) {
          if (err instanceof SessionError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      if (route === "POST /v1/session/abandon") {
        const body = await readJsonBody<{ reason?: string }>(req);
        const s = await abandonSession({ cwd: opts.cwd, ...(body?.reason ? { reason: body.reason } : {}) });
        return sendJson(res, 200, s ?? null);
      }

      if (route === "GET /v1/models") {
        const r = await listModels({ cwd: opts.cwd });
        // v0.13: include viability for each profile so the GUI can show a badge.
        const { checkProfileViability } = await import("../model/profileViability.js");
        const viabilities = await Promise.all(
          r.entries.map(async (e) => {
            const v = await checkProfileViability(e.profile, env);
            return { id: e.id, viability: { ok: v.viable, ...(v.reason ? { reason: v.reason } : {}) } };
          }),
        );
        const viabilityMap: Record<string, { ok: boolean; reason?: string }> = {};
        for (const v of viabilities) viabilityMap[v.id] = v.viability;
        const entriesWithViability = r.entries.map((e) => ({ ...e, viability: viabilityMap[e.id] }));
        return sendJson(res, 200, { ...r, entries: entriesWithViability });
      }

      if (route === "POST /v1/notices") {
        const body = await readJsonBody<Record<string, boolean>>(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendJson(res, 400, { error: "request must be an object of boolean flags" });
        }
        const file = path.join(opts.cwd, "tierkit.config.json");
        let raw: Record<string, unknown> = {};
        try { raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>; } catch { /* fresh */ }
        raw.notices = { ...(typeof raw.notices === "object" && raw.notices !== null ? raw.notices as Record<string, unknown> : {}), ...body };
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(raw, null, 2), "utf8");
        await fs.rename(tmp, file);
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /v1/models/discover") {
        const { discoverOllamaProfiles } = await import("../model/discoverOllamaProfiles.js");
        // force: true busts the 30s cache so the user sees fresh results.
        const discovered = await discoverOllamaProfiles({ force: true });
        return sendJson(res, 200, { ok: true, count: Object.keys(discovered).length, ids: Object.keys(discovered) });
      }

      if (route === "POST /v1/models/test") {
        const body = await readJsonBody<{
          profileId: string;
          smoke?: boolean;
          ignoreDisabled?: boolean;
          testTimeoutMs?: number;
        }>(req);
        if (!body || typeof body.profileId !== "string") {
          return sendJson(res, 400, { error: "request must be { profileId: string, smoke?: boolean, ignoreDisabled?: boolean }" });
        }
        try {
          const r = await testModel({
            cwd: opts.cwd,
            profileId: body.profileId,
            env,
            ...(body.smoke !== undefined ? { smoke: body.smoke } : {}),
            ...(body.ignoreDisabled !== undefined ? { ignoreDisabled: body.ignoreDisabled } : {}),
            ...(body.testTimeoutMs !== undefined ? { testTimeoutMs: body.testTimeoutMs } : {}),
          });
          return sendJson(res, 200, { probe: r.result, smoke: r.smoke ?? null });
        } catch (err) {
          if (err instanceof TestModelError) {
            // profile-disabled → 409, unknown-profile → 404, everything else 400
            const status = err.code === "profile-disabled" ? 409 : err.code === "unknown-profile" ? 404 : 400;
            return sendJson(res, status, { error: { type: err.code === "profile-disabled" ? "profile_disabled" : err.code, message: err.message, profileId: body.profileId } });
          }
          throw err;
        }
      }

      if (route === "POST /v1/route/explain") {
        const body = await readJsonBody<{ task: string; mode?: "execute" | "review-only" }>(req);
        if (!body || typeof body.task !== "string" || body.task.length === 0) {
          return sendJson(res, 400, { error: "request must be { task: string, mode?: 'execute'|'review-only' }" });
        }

        const { decideRoute } = await import("../model/ModelRouter.js");
        const { classifyTask } = await import("../model/TaskClassifier.js");
        const { checkProfileViability } = await import("../model/profileViability.js");

        const cfg = await loadConfig(opts.cwd);
        const policy = cfg.config.routingPolicy;
        const taskType = classifyTask(body.task);
        const decision = decideRoute({
          task: { task: body.task, taskType },
          profiles: cfg.config.modelProfiles,
          ...(cfg.config.modelPolicy ? { policy: cfg.config.modelPolicy } : {}),
          thresholds: policy.riskThresholds,
          ceiling: policy.autoEscalationCeiling,
          taskType,
        });

        // Per-candidate viability probe (parallel)
        const candidates = await Promise.all(decision.escalationChain.map(async (c) => {
          const profile = cfg.config.modelProfiles[c.id]!;
          const v = await checkProfileViability(profile, env);
          return {
            id: c.id,
            tier: c.tier,
            isEscalation: c.isEscalation,
            viable: v.viable,
            ...(v.reason ? { viabilityReason: v.reason } : {}),
            selected: false,
          };
        }));
        // Mark the first viable candidate as selected (mirrors actual routing behavior)
        const firstViable = candidates.find((c) => c.viable);
        if (firstViable) firstViable.selected = true;

        return sendJson(res, 200, {
          taskType,
          score: decision.score,
          reasons: decision.reasons,
          tier: decision.tier,
          ceiling: policy.autoEscalationCeiling,
          candidates,
        });
      }

      if (route === "GET /v1/plugins") {
        const r = await listPlugins({ cwd: opts.cwd });
        return sendJson(res, 200, r);
      }

      // NOTE: drafts under `.tierkit/runtime/plugin-drafts/<uuid>/` are cleaned up on
      // successful install only. TTL-based cleanup at daemon startup (spec §2) is a
      // known follow-up — abandoned drafts will accumulate until manual cleanup.
      if (route === "POST /v1/plugins/generate") {
        const body = await readJsonBody<{ description: string }>(req);
        if (!body || typeof body.description !== "string") {
          return sendJson(res, 400, { error: "request must be { description: string }" });
        }
        try {
          const { generatePlugin } = await import("../usecases/generatePlugin.js");
          const r = await generatePlugin({ description: body.description, cwd: opts.cwd, env });
          return sendJson(res, 200, {
            ok: true,
            draftId: r.draftId,
            manifest: r.manifest,
            rules: r.rules,
            modelUsed: r.modelUsed,
          });
        } catch (err) {
          const e = err as { code?: string; message?: string; rawOutput?: string };
          // Client errors → 400
          if (e.code === "invalid-description" || e.code === "description-too-long" || e.code === "validation-failed") {
            return sendJson(res, 400, {
              ok: false,
              code: e.code,
              message: e.message,
              ...(e.rawOutput ? { rawOutput: e.rawOutput } : {}),
            });
          }
          // Server-side errors (LLM unreachable, budget exhausted, no candidates) → 503
          return sendJson(res, 503, {
            ok: false,
            code: e.code ?? "generate-failed",
            message: e.message ?? "generation failed",
            ...(e.rawOutput ? { rawOutput: e.rawOutput } : {}),
          });
        }
      }

      if (route === "POST /v1/plugins/generate/install") {
        const body = await readJsonBody<{ draftId: string; enable?: boolean }>(req);
        if (!body || typeof body.draftId !== "string" || !/^[0-9a-f-]{36}$/.test(body.draftId)) {
          return sendJson(res, 400, { error: "request must be { draftId: uuid }" });
        }
        const cfg = await loadConfig(opts.cwd);
        const draftPath = path.join(opts.cwd, cfg.config.runtime.dataDir, "plugin-drafts", body.draftId);
        try {
          await fs.access(draftPath);
        } catch {
          return sendJson(res, 404, { ok: false, code: "draft-not-found", message: "draft not found or expired" });
        }
        const ins = await installPlugin({ pluginPath: draftPath, cwd: opts.cwd, force: true });
        let enabled = false;
        if (body.enable) {
          try {
            await enablePlugin({ pluginId: ins.pluginId, cwd: opts.cwd });
            enabled = true;
          } catch (err) {
            const e = err as { code?: string };
            if (e.code === "no-config") {
              // Auto-init the workspace so Enable can succeed on first run.
              await initProject({ cwd: opts.cwd });
              await enablePlugin({ pluginId: ins.pluginId, cwd: opts.cwd });
              enabled = true;
            } else {
              throw err;
            }
          }
        }
        await fs.rm(draftPath, { recursive: true, force: true });
        return sendJson(res, 200, { ok: true, pluginId: ins.pluginId, version: ins.version, installedPath: ins.installedPath, enabled });
      }

      // ── Config mutation: add/remove model profiles, scaffold workspace config ──
      if (route === "POST /v1/config/profile") {
        const body = await readJsonBody<{ id: string; profile: unknown; scope?: ProfileScope }>(req);
        if (!body || typeof body.id !== "string" || typeof body.profile !== "object" || body.profile === null) {
          return sendJson(res, 400, { error: "request must be { id: string, profile: ModelProfile, scope?: 'workspace'|'user' }" });
        }
        try {
          const r = await addProfile({
            cwd: opts.cwd,
            id: body.id,
            profile: body.profile as never,
            ...(body.scope ? { scope: body.scope } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof ProfileCrudError) return sendJson(res, 400, { code: err.code, message: err.message });
          if (err && typeof err === "object" && "issues" in (err as Record<string, unknown>)) {
            return sendJson(res, 400, { code: "invalid-profile", message: (err as Error).message });
          }
          throw err;
        }
      }

      if (method === "DELETE" && url.pathname.startsWith("/v1/config/profile/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/config/profile/".length));
        const scope = (url.searchParams.get("scope") === "user" ? "user" : "workspace") as ProfileScope;
        if (!id) return sendJson(res, 400, { error: "missing profile id in path" });

        // Reject delete for sources that re-create themselves (bundled samples,
        // auto-discovered Ollama profiles). User must use toggle (PATCH with
        // enabled:false) instead. Without this guard the suppression marker would
        // be written, but the user can't see "why" the profile keeps coming back.
        try {
          const cfg = await loadConfig(opts.cwd);
          const source = cfg.profileSources[id];
          if (source === "bundled" || source === "discovered") {
            return sendJson(res, 400, {
              ok: false,
              code: "cannot-delete-non-editable",
              message: `cannot delete '${id}' (source: ${source}). Toggle it off instead — it will be re-created automatically otherwise.`,
            });
          }
        } catch {
          // If loadConfig fails, fall through to the existing remove path; the
          // CRUD layer will surface a better error than swallowing here.
        }

        try {
          const r = await removeProfile({ cwd: opts.cwd, id, scope });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof ProfileCrudError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      if (method === "PATCH" && url.pathname.startsWith("/v1/config/profile/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/config/profile/".length));
        if (!id) return sendJson(res, 400, { error: "missing profile id in path" });
        const body = await readJsonBody<{
          enabled?: boolean;
          scope?: ProfileScope;
          roles?: string[];
          goodAt?: string[];
          notGoodAt?: string[];
        }>(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendJson(res, 400, { error: "request must be a JSON object" });
        }
        const scope: ProfileScope = body.scope === "user" ? "user" : "workspace";
        // If body contains enabled (toggle use-case), handle that path.
        if (typeof body.enabled === "boolean") {
          try {
            const r = await updateProfileEnabled({ cwd: opts.cwd, id, scope, enabled: body.enabled });
            return sendJson(res, 200, r);
          } catch (err) {
            if (err instanceof ProfileCrudError) return sendJson(res, 400, { code: err.code, message: err.message });
            throw err;
          }
        }
        // Otherwise handle profile-fields patch (roles, goodAt, notGoodAt).
        const hasPatch = "roles" in body || "goodAt" in body || "notGoodAt" in body;
        if (!hasPatch) {
          return sendJson(res, 400, { error: "request must include enabled, roles, goodAt, or notGoodAt" });
        }
        try {
          const { updateProfileFields } = await import("../usecases/profileCrud.js");
          const r = await updateProfileFields({
            cwd: opts.cwd,
            id,
            scope,
            ...(body.roles !== undefined ? { roles: body.roles } : {}),
            ...(body.goodAt !== undefined ? { goodAt: body.goodAt } : {}),
            ...(body.notGoodAt !== undefined ? { notGoodAt: body.notGoodAt } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof ProfileCrudError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      // ── Environment probe (onboarding checklist data source) ──
      if (route === "GET /v1/environment") {
        try {
          const { TASK_TYPES } = await import("../model/TaskClassifier.js");
          const cfg = await loadConfig(opts.cwd);
          const profiles = cfg.config.modelProfiles ?? {};

          // Ollama: probe any local-device ollama profile's baseUrl for /api/tags
          const ollamaProfile = Object.values(profiles).find(
            (p) => p && (p as { provider?: string }).provider === "ollama",
          ) as ({ baseUrl?: string } & Record<string, unknown>) | undefined;
          const ollamaBaseUrl =
            (ollamaProfile?.baseUrl as string | undefined) ?? "http://127.0.0.1:11434";
          let ollamaRunning = false;
          let ollamaModelCount: number | undefined;
          try {
            const r = await fetch(`${ollamaBaseUrl}/api/tags`, {
              signal: AbortSignal.timeout(1500),
            });
            if (r.ok) {
              const data = (await r.json()) as { models?: unknown[] };
              ollamaRunning = true;
              ollamaModelCount = Array.isArray(data.models) ? data.models.length : 0;
            }
          } catch {
            /* unreachable — treat as not running */
          }

          // claudeCli: check claudeCode profile viability via subprocess transport
          const env = (opts.env ?? process.env) as Record<string, string | undefined>;
          const claudeCodeProfile = profiles["claudeCode"] as
            | (Record<string, unknown> & { transport?: unknown })
            | undefined;
          let claudeCliOnPath = false;
          if (claudeCodeProfile?.transport) {
            try {
              const { checkProfileViability } = await import("../model/profileViability.js");
              const v = await checkProfileViability(
                claudeCodeProfile as Parameters<typeof checkProfileViability>[0],
                env,
              );
              claudeCliOnPath = v.viable;
            } catch {
              claudeCliOnPath = false;
            }
          }

          // envVars: check apiKeyEnv of every profile + the three standard defaults
          const defaultKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
          const wantedKeys = new Set<string>(defaultKeys);
          for (const p of Object.values(profiles)) {
            const k = (p as { apiKeyEnv?: string }).apiKeyEnv;
            if (typeof k === "string" && k) wantedKeys.add(k);
          }
          const envVars: Record<string, { present: boolean; source: "process" | "secrets" | "none" }> = {};
          for (const k of wantedKeys) {
            const inProcess = k in env && env[k] !== undefined && env[k] !== "";
            const inSecrets = opts.secrets
              ? opts.secrets.list({ knownKeys: [k] }).entries.find((e) => e.key === k)?.set === true
              : false;
            envVars[k] = {
              present: inProcess || inSecrets,
              source: inProcess ? "process" : inSecrets ? "secrets" : "none",
            };
          }

          return sendJson(res, 200, {
            ollama: { running: ollamaRunning, modelCount: ollamaModelCount, baseUrl: ollamaBaseUrl },
            claudeCli: { onPath: claudeCliOnPath },
            envVars,
            taskTypes: TASK_TYPES,
          });
        } catch (err) {
          return sendJson(res, 500, { code: "environment-probe-failed", message: (err as Error).message });
        }
      }

      // ── Tool connection status (Mission Control reads this) ──
      if (route === "GET /v1/connections") {
        const r = await listConnections(opts.cwd);
        return sendJson(res, 200, { connections: r });
      }

      // ── Resolved config snapshot (read-only). Sensitive fields (API key envs/values) are
      // returned by name, not value — the daemon never echoes secrets back over HTTP. ──
      if (route === "GET /v1/config") {
        try {
          const cfg = await loadConfig(opts.cwd);
          const sanitized = JSON.parse(JSON.stringify(cfg.config)) as Record<string, unknown>;
          const profiles = (sanitized.modelProfiles as Record<string, Record<string, unknown>> | undefined) ?? {};
          for (const p of Object.values(profiles)) {
            if ("apiKey" in p) p.apiKey = "[redacted]";
          }
          return sendJson(res, 200, {
            configPath: cfg.configPath,
            userConfigPath: cfg.userConfigPath,
            found: cfg.found,
            profileSources: cfg.profileSources,
            config: sanitized,
          });
        } catch (err) {
          return sendJson(res, 500, { code: "config-load-failed", message: (err as Error).message });
        }
      }

      if (method === "PATCH" && url.pathname === "/v1/config/routing") {
        const body = await readJsonBody<{
          autoEscalationCeiling?: unknown;
          budgetAwareDowngrade?: unknown;
          responseQualityCheck?: unknown;
          riskThresholds?: unknown;
        }>(req);
        if (!body || typeof body !== "object") {
          return sendJson(res, 400, { error: "request must be JSON object" });
        }
        const allowed = ["autoEscalationCeiling", "budgetAwareDowngrade", "responseQualityCheck"] as const;
        const patch: Record<string, unknown> = {};
        for (const k of allowed) {
          if (k in body) patch[k] = (body as Record<string, unknown>)[k];
        }
        if (patch.autoEscalationCeiling !== undefined &&
            !["local-device", "private-remote", "public-cloud"].includes(patch.autoEscalationCeiling as string)) {
          return sendJson(res, 400, { error: "autoEscalationCeiling must be one of local-device|private-remote|public-cloud" });
        }
        for (const k of ["budgetAwareDowngrade", "responseQualityCheck"] as const) {
          if (patch[k] !== undefined && typeof patch[k] !== "boolean") {
            return sendJson(res, 400, { error: `${k} must be boolean` });
          }
        }
        // riskThresholds: shallow validate each numeric field, allow partial patches.
        if (body.riskThresholds !== undefined) {
          if (typeof body.riskThresholds !== "object" || body.riskThresholds === null || Array.isArray(body.riskThresholds)) {
            return sendJson(res, 400, { error: "riskThresholds must be an object" });
          }
          const rt = body.riskThresholds as Record<string, unknown>;
          const rtAllowed = ["localFastMax", "localStrongMax", "privateRemoteMax", "publicCloudReviewMin"] as const;
          const validated: Record<string, number> = {};
          for (const k of rtAllowed) {
            if (k in rt) {
              const v = rt[k];
              if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
                return sendJson(res, 400, { error: `${k} must be an integer in [0, 100]` });
              }
              validated[k] = v;
            }
          }
          patch.riskThresholds = validated;
        }
        const configPath = path.join(opts.cwd, "tierkit.config.json");
        let existing: Record<string, unknown>;
        try {
          existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          existing = { version: "0.1", modelProfiles: {} };
        }
        const rp = (existing.routingPolicy as Record<string, unknown>) ?? {};
        // riskThresholds must merge deeply so partial patches don't drop the unspecified fields.
        if (patch.riskThresholds) {
          patch.riskThresholds = { ...(rp.riskThresholds as Record<string, unknown> | undefined), ...(patch.riskThresholds as Record<string, unknown>) };
        }
        existing.routingPolicy = { ...rp, ...patch };
        await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
        return sendJson(res, 200, { ok: true, routingPolicy: existing.routingPolicy });
      }

      // Preset endpoints — list available presets + apply one by name.
      if (route === "GET /v1/config/presets") {
        const { listPresets } = await import("../usecases/applyConfigPreset.js");
        return sendJson(res, 200, { presets: listPresets() });
      }
      if (route === "POST /v1/config/preset") {
        const body = await readJsonBody<{ name?: string }>(req);
        if (!body || typeof body.name !== "string") {
          return sendJson(res, 400, { error: "request must be { name: string }" });
        }
        try {
          const { applyConfigPreset, PresetError } = await import("../usecases/applyConfigPreset.js");
          const r = await applyConfigPreset({ cwd: opts.cwd, name: body.name });
          return sendJson(res, 200, { ok: true, ...r });
        } catch (err) {
          if ((err as { code?: string }).code === "unknown-preset") {
            return sendJson(res, 400, { ok: false, code: "unknown-preset", message: (err as Error).message });
          }
          throw err;
        }
      }

      // ── Secrets management: GET/POST/DELETE /v1/secrets ──
      if (route === "GET /v1/secrets") {
        if (!opts.secrets) return sendJson(res, 501, { error: "secrets store not configured" });
        const cfg = await loadConfig(opts.cwd);
        const known = new Set<string>();
        const profiles = cfg.config.modelProfiles ?? {};
        for (const p of Object.values(profiles)) {
          const k = (p as { apiKeyEnv?: string }).apiKeyEnv;
          if (typeof k === "string" && k) known.add(k);
        }
        const r = opts.secrets.list({ knownKeys: [...known] });
        return sendJson(res, 200, r);
      }

      if (route === "POST /v1/secrets") {
        if (!opts.secrets) return sendJson(res, 501, { error: "secrets store not configured" });
        const body = await readJsonBody<{ key: string; value: string }>(req);
        if (!body || typeof body.key !== "string" || typeof body.value !== "string") {
          return sendJson(res, 400, { error: "request must be { key: string, value: string }" });
        }
        try {
          await opts.secrets.set(body.key, body.value);
          const listed = opts.secrets.list({ knownKeys: [body.key] });
          const entry = listed.entries.find((e) => e.key === body.key);
          return sendJson(res, 200, { ok: true, masked: entry?.masked ?? "" });
        } catch (err) {
          return sendJson(res, 400, { code: "invalid", message: (err as Error).message });
        }
      }

      if (method === "DELETE" && url.pathname.startsWith("/v1/secrets/")) {
        if (!opts.secrets) return sendJson(res, 501, { error: "secrets store not configured" });
        const key = decodeURIComponent(url.pathname.slice("/v1/secrets/".length));
        if (!key) return sendJson(res, 400, { error: "missing key in path" });
        const ok = await opts.secrets.remove(key);
        if (!ok) {
          return sendJson(res, 400, {
            ok: false,
            code: "external",
            message: "key was set by the shell env, not by Tierkit — cannot remove",
          });
        }
        return sendJson(res, 200, { ok: true });
      }

      // ── Workspace file listing (used by @filename autocomplete in the GUI) ──
      if (route === "GET /v1/workspace/files") {
        const prefix = (url.searchParams.get("prefix") ?? "").slice(0, 200);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 1), 200);
        try {
          const r = await listWorkspaceFiles(opts.cwd, prefix, limit);
          return sendJson(res, 200, { files: r });
        } catch (err) {
          return sendJson(res, 500, { code: "list-failed", message: (err as Error).message });
        }
      }

      // ── Plugin lifecycle (Mission Control toggles use these) ──
      if (route === "POST /v1/plugins/enable") {
        const body = await readJsonBody<{ pluginId: string }>(req);
        if (!body || typeof body.pluginId !== "string") {
          return sendJson(res, 400, { error: "request must be { pluginId: string }" });
        }
        try {
          const r = await enablePlugin({
            cwd: opts.cwd,
            pluginId: body.pluginId,
            ...(opts.adapters ? { adapters: opts.adapters } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof PluginLifecycleError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      if (route === "POST /v1/plugins/disable") {
        const body = await readJsonBody<{ pluginId: string }>(req);
        if (!body || typeof body.pluginId !== "string") {
          return sendJson(res, 400, { error: "request must be { pluginId: string }" });
        }
        try {
          const r = await disablePlugin({
            cwd: opts.cwd,
            pluginId: body.pluginId,
            ...(opts.adapters ? { adapters: opts.adapters } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof PluginLifecycleError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      // ── Tool connection + plugin sync + plugin scaffold ──
      if (route === "POST /v1/connect") {
        const body = await readJsonBody<{ tool: ConnTool; tierkitBaseUrl?: string; defaultProfile?: string }>(req);
        if (!body || !body.tool) {
          return sendJson(res, 400, { error: "request must be { tool: 'roo'|'cline'|'continue', ... }" });
        }
        try {
          const r = await connectTool({
            cwd: opts.cwd,
            tool: body.tool,
            ...(body.tierkitBaseUrl ? { tierkitBaseUrl: body.tierkitBaseUrl } : {}),
            ...(body.defaultProfile ? { defaultProfile: body.defaultProfile } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          return sendJson(res, 400, { code: "connect-failed", message: (err as Error).message });
        }
      }

      if (route === "POST /v1/plugins/sync") {
        const body = await readJsonBody<{ tools?: ConnTool[] }>(req);
        const r = await syncPlugins({
          cwd: opts.cwd,
          adapters: opts.adapters ?? {},
          ...(body?.tools ? { tools: body.tools } : {}),
        });
        return sendJson(res, 200, r);
      }

      if (route === "POST /v1/plugins/new") {
        const body = await readJsonBody<{
          id: string;
          name?: string;
          description?: string;
          author?: string;
          force?: boolean;
          freedomLevel?: "free" | "guided" | "balanced" | "strict";
          firstCommand?: string;
        }>(req);
        if (!body || typeof body.id !== "string") {
          return sendJson(res, 400, { error: "request must be { id: string, ...optional fields }" });
        }
        try {
          const r = await pluginNew({
            cwd: opts.cwd,
            id: body.id,
            ...(body.name ? { name: body.name } : {}),
            ...(body.description ? { description: body.description } : {}),
            ...(body.author ? { author: body.author } : {}),
            ...(body.force ? { force: body.force } : {}),
            ...(body.freedomLevel ? { freedomLevel: body.freedomLevel } : {}),
            ...(body.firstCommand ? { firstCommand: body.firstCommand } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof PluginNewError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      // ── Install from a local directory (wraps the installPlugin usecase the CLI uses) ──
      if (route === "POST /v1/plugins/install") {
        const body = await readJsonBody<{ pluginPath?: string; force?: boolean }>(req);
        if (!body || typeof body.pluginPath !== "string" || body.pluginPath.length === 0) {
          return sendJson(res, 400, { error: "request must be { pluginPath: string, force?: boolean }" });
        }
        try {
          const r = await installPlugin({
            cwd: opts.cwd,
            pluginPath: body.pluginPath,
            ...(body.force ? { force: body.force } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof PluginInstallError) return sendJson(res, 400, { code: "install-failed", message: err.message });
          if (err instanceof PluginLoadError) {
            return sendJson(res, 400, {
              code: "plugin-load-failed",
              message: `failed to load plugin from ${err.pluginDir}`,
              issues: err.issues,
            });
          }
          throw err;
        }
      }

      // ── Remove (uninstall): drops the registry entry and removes the on-disk plugin dir ──
      if (route === "POST /v1/plugins/remove") {
        const body = await readJsonBody<{ pluginId?: string }>(req);
        if (!body || typeof body.pluginId !== "string") {
          return sendJson(res, 400, { error: "request must be { pluginId: string }" });
        }
        try {
          const r = await removePlugin({
            cwd: opts.cwd,
            pluginId: body.pluginId,
            ...(opts.adapters ? { adapters: opts.adapters } : {}),
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof PluginLifecycleError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }

      // ── OpenAI-compatible inbound endpoint ──
      // Two paths cover both "configure base_url=http://127.0.0.1:4101/v1/openai" (we get
      // /v1/openai/chat/completions) and tools that strip the /openai segment expecting
      // standard /v1/chat/completions. Both land here.
      if (
        route === "POST /v1/openai/chat/completions" ||
        route === "POST /v1/chat/completions"
      ) {
        const body = await readJsonBody<unknown>(req);
        await handleOpenAIChatCompletions(req, res, body, { cwd: opts.cwd, env });
        return;
      }

      // Anthropic Gateway Phase 0 spike (branch only — not shipped to users yet):
      // Transparent passthrough so Claude Code can be pointed at Tierkit via
      // ANTHROPIC_BASE_URL=http://127.0.0.1:4101. No compression, no redaction,
      // no UI, no auto-wire — those land in Phase 1+ after the spike's RFC
      // answers the three open validation questions. See
      // docs/RFC-anthropic-gateway.md.
      if (route === "POST /v1/messages") {
        const body = await readRawBody(req);
        const wantsStream = isStreamingMessagesBody(body);
        try {
          if (wantsStream) {
            await streamMessages(req, body, res);
            return;
          }
          const r = await forwardMessages(req, body);
          for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
          res.statusCode = r.status;
          res.end(r.body);
          return;
        } catch (err) {
          // If we already started streaming (headers or chunks sent), we cannot
          // pivot to a JSON 502 — the client would see a mixed-protocol response.
          // Destroy the socket instead; Claude Code surfaces this as a network
          // error, which is the honest signal.
          if (res.headersSent) {
            res.destroy(err as Error);
            return;
          }
          return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
        }
      }

      if (route === "POST /v1/messages/count_tokens") {
        const body = await readRawBody(req);
        try {
          const r = await forwardCountTokens(req, body);
          for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
          res.statusCode = r.status;
          res.end(r.body);
          return;
        } catch (err) {
          return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
        }
      }

      if (route === "POST /v1/config/init") {
        const body = await readJsonBody<{ force?: boolean; defaultTarget?: "roo" | "zoo" | "cline" | "continue" | "claude-code" | "generic" }>(req);
        const r = await initProject({
          cwd: opts.cwd,
          ...(body?.force !== undefined ? { force: body.force } : {}),
          ...(body?.defaultTarget !== undefined ? { defaultTarget: body.defaultTarget } : {}),
        });
        return sendJson(res, 200, r);
      }

      // ── MCP Bridge: config snippet + patch ticket admin ──
      if (route === "GET /v1/mcp/config") {
        const realRoot = await fs.realpath(opts.cwd);
        // format param ignored in v0.15.0 — all formats currently return the same shape
        const config = {
          mcpServers: {
            tierkit: {
              type: "stdio",
              command: "tierkit",
              args: ["mcp", "serve", "--workspace", realRoot],
            },
          },
        };
        return sendJson(res, 200, config);
      }

      if (route === "GET /v1/mcp/patches") {
        const patches = await listPatchTickets(opts.cwd);
        return sendJson(res, 200, { patches });
      }

      const approveMatch = method === "POST" && url.pathname.match(/^\/v1\/mcp\/patches\/([^/]+)\/approve$/);
      if (approveMatch) {
        const id = approveMatch[1]!;
        try { await readPatchTicket(opts.cwd, id); }
        catch (err: unknown) {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return sendJson(res, 404, { error: "patch not found" });
          }
          throw err;
        }
        const body = await readJsonBody<{ note?: string }>(req).catch(() => undefined);
        try {
          await approvePatchTicket(opts.cwd, id, "gui", body?.note ?? null);
        } catch (err) {
          if (err instanceof InvalidPatchStateError) {
            return sendJson(res, 409, { error: err.message });
          }
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      const rejectMatch = method === "POST" && url.pathname.match(/^\/v1\/mcp\/patches\/([^/]+)\/reject$/);
      if (rejectMatch) {
        const id = rejectMatch[1]!;
        try { await readPatchTicket(opts.cwd, id); }
        catch (err: unknown) {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return sendJson(res, 404, { error: "patch not found" });
          }
          throw err;
        }
        const body = await readJsonBody<{ note?: string }>(req).catch(() => undefined);
        try {
          await rejectPatchTicket(opts.cwd, id, "gui", body?.note ?? null);
        } catch (err) {
          if (err instanceof InvalidPatchStateError) {
            return sendJson(res, 409, { error: err.message });
          }
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      // ── GUI ──
      if (route === "GET /v1/ui" || route === "GET /" || route === "GET /ui") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(GUI_HTML);
        return;
      }

      sendJson(res, 404, { error: `unknown route ${route}` });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  // Bootstrap: ensure every entry in opts.bootstrapPlugins is installed (per-item,
  // idempotent). Each install is its own try/catch — if the plugin is already in the
  // registry (PluginInstallError "already installed"), we silently skip and treat the
  // existing id as "still here" so a subsequent autoEnable still flips the toggle.
  // Items marked autoEnable run through enablePlugin (also idempotent — adding an
  // already-active id to activePlugins is a no-op).
  //
  // We DON'T gate on "registry empty" anymore: users who upgrade from an earlier
  // bootstrap (which installed only one sample) would otherwise never get the rest.
  // Trade-off: a sample the user explicitly `[✕]`-removed will be re-installed on
  // daemon restart. The intended way to silence a sample is the ON/OFF toggle, not
  // uninstall.
  //
  // Runs concurrently with server.listen — never blocks daemon startup.
  if (opts.bootstrapPlugins && opts.bootstrapPlugins.length > 0) {
    void (async () => {
      const idsToEnable: string[] = [];
      for (const item of opts.bootstrapPlugins!) {
        try {
          const r = await installPlugin({ cwd: opts.cwd, pluginPath: item.path });
          if (item.autoEnable) idsToEnable.push(r.pluginId);
        } catch (err) {
          // "already installed" is success-equivalent for bootstrap: the user has it,
          // we want it, end-state matches. We DO still need its pluginId for autoEnable —
          // derive it from the path's basename, which matches the installed id by
          // convention for the bundled samples.
          if (err instanceof PluginInstallError && /already installed/.test(err.message)) {
            if (item.autoEnable) {
              const inferred = item.path.split(/[\\/]/).filter(Boolean).pop();
              if (inferred) idsToEnable.push(inferred);
            }
            continue;
          }
          // eslint-disable-next-line no-console
          console.error(`[tierkit] bootstrap install "${item.path}" failed:`, (err as Error).message);
        }
      }
      if (idsToEnable.length === 0) return;
      try {
        const cfg = await loadConfig(opts.cwd);
        if (!cfg.found) {
          await initProject({ cwd: opts.cwd });
        }
        for (const pluginId of idsToEnable) {
          try {
            await enablePlugin({
              cwd: opts.cwd,
              pluginId,
              ...(opts.adapters ? { adapters: opts.adapters } : {}),
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[tierkit] bootstrap enable "${pluginId}" failed:`, (err as Error).message);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[tierkit] bootstrap config-init failed:", (err as Error).message);
      }
    })();
  }

  savingsBroadcaster.start({
    getConfig: () => cachedConfig ?? ({ modelProfiles: {}, routingBaseline: "claudeCode" } as TierkitConfig),
    workspaceRootForHeartbeat: opts.cwd,
    ...(opts.homeDir ? { homeDirOverride: opts.homeDir } : {}),
  });
  setActivityListener((root) => { void savingsBroadcaster.broadcast(root); });

  return new Promise<RunningServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, async () => {
      const addr = server.address() as AddressInfo | null;
      const port = addr?.port ?? opts.port;
      // v0.13 BREAKING notice. Suppressed once the user dismisses the GUI banner
      // or sets notices.seenPinnedNoFallbackV013. Skipped under TIERKIT_NO_BUNDLED_DEFAULTS=1
      // (test runs) to avoid racing migration writes against test temp-dir cleanup.
      if (process.env.TIERKIT_NO_BUNDLED_DEFAULTS !== "1") {
        try {
          const cfg = await loadConfig(opts.cwd);
          if (cfg.config.notices?.seenPinnedNoFallbackV013 !== true) {
            // eslint-disable-next-line no-console
            console.log(`[info] v0.13: pinned profiles no longer fall back to local. Use model:"auto" for fallback routing.`);
          }
        } catch {
          // Config not yet present (first boot before init) — skip the notice silently.
        }
      }
      resolve({
        address: opts.host,
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              // Stop the broadcaster and listener AFTER all in-flight requests
              // have drained — otherwise a request handler in mid-await can
              // re-add a subscriber to a just-cleared set, leaking it.
              savingsBroadcaster.stop();
              setActivityListener(null);
              // Also tear down any Ollama daemon WE auto-launched. If the user had Ollama
              // running before Tierkit started, this is a no-op — we only kill what we spawned.
              void shutdownSpawnedOllama();
              if (err) rejectClose(err);
              else resolveClose();
            });
          }),
      });
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((a, b) => a + b.length, 0) > 5_000_000) {
      throw new Error("request body too large");
    }
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Phase 0 spike: read inbound bytes as a Buffer for byte-faithful upstream
 *  forwarding. Anthropic Messages payloads can be a few hundred KB with full
 *  conversation history + caching, so the 5 MB ceiling matches readJsonBody. */
async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 5_000_000) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** MUST be a real JSON parse, not a regex. A user message that contains the
 *  text `"stream": true` would false-positive a regex check — and the proxy
 *  would switch to streaming mode against a non-streaming request, hanging
 *  Claude Code. Parse once for the decision; the upstream call still gets
 *  the ORIGINAL Buffer (never our re-serialized form). */
function isStreamingMessagesBody(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

/**
 * Walks the workspace once (BFS) and returns up to `limit` paths whose substring matches
 * `prefix` (case-insensitive). Skips well-known noise dirs and any path with a leading dot
 * past the first component to keep the result list small and useful for autocomplete.
 *
 * Bounded by ~30k stat()s — enough for typical monorepos, refuses to recurse past 5k entries
 * to avoid runaway scans.
 */
const FILE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache",
  "coverage", ".pnpm-store", ".tierkit", ".vscode", "out", "target",
]);
const FILE_MAX_VISITED = 5_000;
async function listWorkspaceFiles(root: string, prefix: string, limit: number): Promise<string[]> {
  const needle = prefix.toLowerCase();
  const results: string[] = [];
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && results.length < limit && visited < FILE_MAX_VISITED) {
    const dir = queue.shift() ?? root;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      visited++;
      if (visited > FILE_MAX_VISITED) break;
      if (ent.name.startsWith(".") && ent.name !== ".env.example") continue; // skip dotfiles past root
      if (ent.isDirectory()) {
        if (FILE_SKIP_DIRS.has(ent.name)) continue;
        queue.push(path.join(dir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full);
      if (!needle || rel.toLowerCase().includes(needle)) {
        results.push(rel);
        if (results.length >= limit) break;
      }
    }
  }
  // Prefer matches where the basename starts with the prefix.
  results.sort((a, b) => {
    const aName = path.basename(a).toLowerCase();
    const bName = path.basename(b).toLowerCase();
    const aHit = aName.startsWith(needle) ? 0 : 1;
    const bHit = bName.startsWith(needle) ? 0 : 1;
    if (aHit !== bHit) return aHit - bHit;
    return a.length - b.length;
  });
  return results;
}

function serializeSummary(s: ReturnType<typeof summarizeUsage>): object {
  return {
    totalCalls: s.totalCalls,
    successfulCalls: s.successfulCalls,
    failedCalls: s.failedCalls,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    byProfile: Object.fromEntries(s.byProfile.entries()),
  };
}
