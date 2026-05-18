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

const VERSION = "0.10.3";

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

      if (route === "POST /v1/models/discover") {
        const { discoverOllamaProfiles } = await import("../model/discoverOllamaProfiles.js");
        // force: true busts the 30s cache so the user sees fresh results.
        const discovered = await discoverOllamaProfiles({ force: true });
        return sendJson(res, 200, { ok: true, count: Object.keys(discovered).length, ids: Object.keys(discovered) });
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
        const body = await readJsonBody<{ enabled?: boolean; scope?: ProfileScope }>(req);
        if (!body || typeof body.enabled !== "boolean") {
          return sendJson(res, 400, { error: "request must be { enabled: boolean, scope?: 'workspace'|'user' }" });
        }
        const scope: ProfileScope = body.scope === "user" ? "user" : "workspace";
        try {
          const r = await updateProfileEnabled({ cwd: opts.cwd, id, scope, enabled: body.enabled });
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

      if (method === "PATCH" && url.pathname === "/v1/config/routing") {
        const body = await readJsonBody<{
          autoEscalationCeiling?: unknown;
          budgetAwareDowngrade?: unknown;
          responseQualityCheck?: unknown;
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
        const configPath = path.join(opts.cwd, "tierkit.config.json");
        let existing: Record<string, unknown>;
        try {
          existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          existing = { version: "0.1", modelProfiles: {} };
        }
        const rp = (existing.routingPolicy as Record<string, unknown>) ?? {};
        existing.routingPolicy = { ...rp, ...patch };
        await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
        return sendJson(res, 200, { ok: true, routingPolicy: existing.routingPolicy });
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
