import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { explainRoute } from "../usecases/explainRoute.js";
import { checkCommand } from "../usecases/checkCommand.js";
import { checkPath } from "../usecases/checkPath.js";
import { redactSecrets } from "../security/SecretRedactor.js";
import { loadConfig } from "../config/loadConfig.js";
import { readUsage, summarizeUsage } from "./usageLog.js";
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
import { addProfile, removeProfile, ProfileCrudError, type ProfileScope } from "../usecases/profileCrud.js";
import { initProject } from "../usecases/initProject.js";
import { shutdownSpawnedOllama } from "./../model/providers/ollamaAutoLaunch.js";
import { handleOpenAIChatCompletions } from "./openaiCompat.js";
import { connectTool, listConnections, type ConnectableTool as ConnTool } from "../usecases/connectTool.js";
import { enablePlugin, disablePlugin, PluginLifecycleError } from "../usecases/pluginLifecycle.js";
import { syncPlugins } from "../usecases/syncPlugins.js";
import { pluginNew, PluginNewError } from "../usecases/pluginNew.js";
import type { TierkitAdapter } from "../adapter/TierkitAdapter.js";
import type { Target } from "../plugin/PluginManifest.js";
import { GUI_HTML } from "./ui/gui.js";
import type { SessionState } from "./session/ExecutionSession.js";

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

const VERSION = "0.1.0";

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
export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);

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
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
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
        });
      }

      if (route === "GET /v1/budget") {
        const cfg = await loadConfig(opts.cwd);
        const usagePath = path.join(opts.cwd, cfg.config.runtime.dataDir, "usage.jsonl");
        const result = await checkBudget(usagePath, cfg.config.budget);
        return sendJson(res, 200, result);
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
        return sendJson(res, 200, r);
      }

      if (route === "POST /v1/models/test") {
        const body = await readJsonBody<{ profileId: string }>(req);
        if (!body || typeof body.profileId !== "string") {
          return sendJson(res, 400, { error: "request must be { profileId: string }" });
        }
        try {
          const r = await testModel({ cwd: opts.cwd, profileId: body.profileId, env });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof TestModelError) {
            return sendJson(res, 400, { code: err.code, message: err.message });
          }
          throw err;
        }
      }

      if (route === "GET /v1/plugins") {
        const r = await listPlugins({ cwd: opts.cwd });
        return sendJson(res, 200, r);
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
        try {
          const r = await removeProfile({ cwd: opts.cwd, id, scope });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof ProfileCrudError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
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
        const body = await readJsonBody<{ id: string; name?: string; description?: string; author?: string; force?: boolean }>(req);
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
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof PluginNewError) return sendJson(res, 400, { code: err.code, message: err.message });
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

      if (route === "POST /v1/config/init") {
        const body = await readJsonBody<{ force?: boolean; defaultTarget?: "roo" | "zoo" | "cline" | "continue" | "claude-code" | "generic" }>(req);
        const r = await initProject({
          cwd: opts.cwd,
          ...(body?.force !== undefined ? { force: body.force } : {}),
          ...(body?.defaultTarget !== undefined ? { defaultTarget: body.defaultTarget } : {}),
        });
        return sendJson(res, 200, r);
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

  return new Promise<RunningServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address() as AddressInfo | null;
      const port = addr?.port ?? opts.port;
      resolve({
        address: opts.host,
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
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
