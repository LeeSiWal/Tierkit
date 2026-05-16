/**
 * `@tierkit/agent`'s daemon-side adapter. Plugs into `@tierkit/core`'s `startServer`
 * via the `routeExtensions` option, exposing:
 *
 *   POST /v1/agent/run     — streaming SSE; each chunk is one `AgentEvent` as JSON
 *
 * The endpoint:
 *   - Reads the request body: { task, modelId?, mode?, maxTurns? }
 *   - Spawns the agent loop with the daemon's own URL as `tierkitBaseUrl` (so the agent's
 *     model calls go through the same policy stack as everything else)
 *   - Streams each yielded `AgentEvent` as `data: {...}\n\n`
 *   - Closes the connection with `data: [DONE]\n\n` on `task_complete` / `turn_end` / `error`
 *
 * No auth here because the daemon is loopback-only. Approval of destructive tools (writes,
 * shell commands) is handled by the SSE client — when the agent yields a
 * `tool_approval_pending` event, the client posts back to a coordination endpoint or sends
 * a WebSocket message. For 0.4.0-alpha we default to AUTO-APPROVE all (single-user, local).
 * UI-driven approval comes in a later phase.
 */
import type http from "node:http";
import { runAgent } from "./AgentLoop.js";
import type { AgentEvent, AgentRunInput } from "./types.js";

export interface AgentServerExtensionOptions {
  /**
   * The daemon's own base URL (e.g., `http://127.0.0.1:4101`). The agent uses this for
   * model calls and policy-gate consultation. Defaults to the request's own `host` header,
   * but explicit is safer when the daemon binds 0.0.0.0 etc.
   */
  tierkitBaseUrl?: string;
  /**
   * Approval handler for tools with `approval: "always"`. Defaults to auto-approve.
   * Override to gate via UI / interactive prompt.
   */
  approve?: AgentRunInput["approve"];
}

export function createAgentRouteExtension(options: AgentServerExtensionOptions = {}): {
  name: string;
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<boolean>;
} {
  return {
    name: "agent",
    async handle(req, res, ctx) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = (req.method ?? "GET").toUpperCase();
      if (!(method === "POST" && url.pathname === "/v1/agent/run")) return false;

      // Parse the body.
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += chunk;
      let body: Partial<AgentRunInput> & { task?: string };
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        writeJsonError(res, 400, "request body must be JSON");
        return true;
      }
      if (typeof body.task !== "string" || body.task.length === 0) {
        writeJsonError(res, 400, "request must include { task: string }");
        return true;
      }

      // Determine tierkit base url for the agent's own model calls. Prefer explicit option,
      // otherwise use the Host header (works for normal localhost binding).
      const tierkitBaseUrl =
        options.tierkitBaseUrl ??
        (req.headers.host ? `http://${req.headers.host}` : `http://127.0.0.1:4101`);

      // Open the SSE stream.
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-store");
      res.setHeader("connection", "keep-alive");
      res.flushHeaders?.();

      function send(event: AgentEvent | { type: "stream_open" }): void {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      send({ type: "stream_open" });

      try {
        const input: AgentRunInput = {
          task: body.task,
          cwd: ctx.cwd,
          env: ctx.env,
          tierkitBaseUrl,
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(body.mode ? { mode: body.mode } : {}),
          ...(body.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
          ...(options.approve ? { approve: options.approve } : {}),
        };
        for await (const event of runAgent(input)) {
          send(event);
        }
      } catch (err) {
        send({ type: "error", code: "agent-crashed", message: (err as Error).message });
      } finally {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return true;
    },
  };
}

function writeJsonError(res: http.ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}
