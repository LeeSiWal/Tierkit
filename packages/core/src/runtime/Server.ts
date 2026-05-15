import http from "node:http";
import type { AddressInfo } from "node:net";
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
import { listPlugins } from "../usecases/listPlugins.js";
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

      if (route === "GET /v1/plugins") {
        const r = await listPlugins({ cwd: opts.cwd });
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
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
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
