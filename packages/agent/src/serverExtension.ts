/**
 * `@tierkit/agent`'s daemon-side adapter. Plugs into `@tierkit/core`'s `startServer`
 * via the `routeExtensions` option, exposing:
 *
 *   POST /v1/agent/run         — streaming SSE; each chunk is one `AgentEvent` as JSON
 *   POST /v1/agent/approval    — resolve a pending approval ({ callId, approved })
 *
 * The endpoint:
 *   - Reads the request body: { task, modelId?, mode?, maxTurns?, approvalMode? }
 *   - Spawns the agent loop with the daemon's own URL as `tierkitBaseUrl` (so the agent's
 *     model calls go through the same policy stack as everything else)
 *   - Streams each yielded `AgentEvent` as `data: {...}\n\n`
 *   - Closes the connection with `data: [DONE]\n\n` on terminal events
 *
 * Approval flow (when `approvalMode: "interactive"`):
 *   1. Agent loop hits a tool with `approval: "always"`, calls `ctx.approve(call)`
 *   2. Our approve impl yields `tool_approval_pending` (already handled by AgentLoop),
 *      then awaits a Promise registered in `pendingApprovals[call.id]`
 *   3. Client SSE consumer renders the pending event with [Approve][Deny] buttons
 *   4. Client posts to `POST /v1/agent/approval { callId, approved }` — server resolves
 *      the matching Promise, agent loop proceeds
 *   5. Timeout: 5 min, auto-denies
 *
 * No auth — daemon is loopback-only.
 */
import type http from "node:http";
import { runAgent } from "./AgentLoop.js";
import type { AgentEvent, AgentRunInput, AgentToolCall } from "./types.js";

export interface AgentServerExtensionOptions {
  /** Daemon's own base URL for nested model calls. Defaults to the request's Host header. */
  tierkitBaseUrl?: string;
  /**
   * Default approval handler. Overridden per-request when the body specifies `approvalMode`.
   * If omitted, defaults to auto-approve.
   */
  approve?: AgentRunInput["approve"];
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export function createAgentRouteExtension(options: AgentServerExtensionOptions = {}): {
  name: string;
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<boolean>;
} {
  // Server-wide approval state. callId is unique enough across in-flight tasks (it embeds
  // Date.now() + a counter), so a single Map is fine.
  const pendingApprovals = new Map<string, PendingApproval>();

  function registerApproval(call: AgentToolCall): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const entry = pendingApprovals.get(call.id);
        if (entry) {
          pendingApprovals.delete(call.id);
          entry.resolve(false); // timeout = auto-deny
        }
      }, APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(call.id, { resolve, expiresAt: Date.now() + APPROVAL_TIMEOUT_MS, timer });
    });
  }

  function resolveApproval(callId: string, approved: boolean): boolean {
    const entry = pendingApprovals.get(callId);
    if (!entry) return false;
    pendingApprovals.delete(callId);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    return true;
  }

  return {
    name: "agent",
    async handle(req, res, ctx) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = (req.method ?? "GET").toUpperCase();

      // ── POST /v1/agent/approval ────────────────────────────────────────────
      if (method === "POST" && url.pathname === "/v1/agent/approval") {
        const body = await readJsonBody<{ callId?: string; approved?: boolean }>(req);
        if (!body || typeof body.callId !== "string" || typeof body.approved !== "boolean") {
          writeJsonError(res, 400, "request must be { callId: string, approved: boolean }");
          return true;
        }
        const ok = resolveApproval(body.callId, body.approved);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ resolved: ok }));
        return true;
      }

      // ── POST /v1/agent/run ────────────────────────────────────────────────
      if (!(method === "POST" && url.pathname === "/v1/agent/run")) return false;

      const body = await readJsonBody<Partial<AgentRunInput> & {
        task?: string;
        approvalMode?: "auto" | "interactive";
        attachments?: { mediaType?: string; base64?: string }[];
      }>(req);
      if (!body) {
        writeJsonError(res, 400, "request body must be JSON");
        return true;
      }
      if (typeof body.task !== "string" || body.task.length === 0) {
        writeJsonError(res, 400, "request must include { task: string }");
        return true;
      }

      const tierkitBaseUrl =
        options.tierkitBaseUrl ??
        (req.headers.host ? `http://${req.headers.host}` : `http://127.0.0.1:4101`);

      const approvalMode = body.approvalMode ?? "auto";
      // Choose approval handler: explicit option > interactive registry > auto-approve.
      const approveImpl: AgentRunInput["approve"] = options.approve
        ? options.approve
        : approvalMode === "interactive"
          ? (call: AgentToolCall) => registerApproval(call)
          : async () => true;

      // Open SSE stream.
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-store");
      res.setHeader("connection", "keep-alive");
      res.flushHeaders?.();
      function send(event: AgentEvent | { type: "stream_open" }): void {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      send({ type: "stream_open" });

      // If client aborts, ensure any pending approvals get auto-denied so the loop unblocks
      // AND fire an AbortSignal that the tool layer can use to kill running subprocesses.
      const callIdsForThisRun = new Set<string>();
      const runAbort = new AbortController();
      req.on("close", () => {
        runAbort.abort();
        for (const id of callIdsForThisRun) {
          resolveApproval(id, false);
        }
      });

      try {
        // Validate attachments — must be {mediaType: "image/*", base64: "<non-empty>"} pairs.
        // Limit total size to 20MB to keep daemon memory bounded; reject anything larger
        // (the GUI enforces a smaller cap, this is the daemon safety net).
        const attachments: { mediaType: string; base64: string }[] = [];
        if (Array.isArray(body.attachments)) {
          let totalBytes = 0;
          for (const a of body.attachments) {
            if (!a || typeof a !== "object") continue;
            if (typeof a.mediaType !== "string" || !a.mediaType.startsWith("image/")) continue;
            if (typeof a.base64 !== "string" || a.base64.length === 0) continue;
            totalBytes += a.base64.length;
            if (totalBytes > 20 * 1024 * 1024) break;
            attachments.push({ mediaType: a.mediaType, base64: a.base64 });
          }
        }

        const input: AgentRunInput = {
          task: body.task,
          cwd: ctx.cwd,
          env: ctx.env,
          tierkitBaseUrl,
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(body.mode ? { mode: body.mode } : {}),
          ...(body.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          approve: approveImpl,
          abortSignal: runAbort.signal,
        };
        for await (const event of runAgent(input)) {
          if (event.type === "tool_approval_pending") {
            callIdsForThisRun.add(event.call.id);
          }
          if (event.type === "tool_approval_resolved") {
            callIdsForThisRun.delete(event.call.id);
          }
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

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) raw += chunk;
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonError(res: http.ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}
