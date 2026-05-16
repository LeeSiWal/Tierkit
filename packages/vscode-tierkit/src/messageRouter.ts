/**
 * Pure message router for the Tierkit sidebar webview. Translates
 * `tk:req` / `tk:stream` / `tk:abort` messages from the webview into
 * daemon HTTP calls via injected fetch/stream helpers, and posts
 * `tk:res` / `tk:chunk` / `tk:done` / `tk:err` back.
 *
 * Pure module — does not import the `vscode` API. Wired up by extension.ts
 * which supplies the actual fetch/streaming logic and the webview's
 * postMessage callback.
 */

export interface FetchProxyResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface MessageRouterOptions {
  getBaseUrl: () => string;
  fetchProxy: (url: string, init: { method: string; body?: string; signal: AbortSignal }) => Promise<FetchProxyResponse>;
  streamProxy: (
    url: string,
    init: { method: string; body?: string; signal: AbortSignal },
  ) => AsyncIterable<{ data: string }>;
  log: (line: string) => void;
}

export interface IncomingMessage {
  type: string;
  id?: number;
  method?: string;
  path?: string;
  body?: unknown;
}

export interface MessageRouter {
  handle: (msg: IncomingMessage, postMessage: (m: unknown) => void) => Promise<void>;
  disposeAll: () => void;
}

export function createMessageRouter(opts: MessageRouterOptions): MessageRouter {
  const inflight = new Map<number, AbortController>();

  async function handleReq(msg: IncomingMessage, post: (m: unknown) => void): Promise<void> {
    if (typeof msg.id !== "number" || typeof msg.path !== "string") return;
    const ctrl = new AbortController();
    inflight.set(msg.id, ctrl);
    try {
      const init = {
        method: (msg.method || "GET").toUpperCase(),
        body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
        signal: ctrl.signal,
      };
      const res = await opts.fetchProxy(opts.getBaseUrl() + msg.path, init);
      post({ type: "tk:res", id: msg.id, ok: res.ok, status: res.status, data: res.data });
    } catch (err) {
      if (ctrl.signal.aborted) return; // disposed or explicit abort — don't post to a possibly-dead webview
      post({ type: "tk:err", id: msg.id, message: (err as Error).message });
    } finally {
      inflight.delete(msg.id);
    }
  }

  async function handleStream(msg: IncomingMessage, post: (m: unknown) => void): Promise<void> {
    if (typeof msg.id !== "number" || typeof msg.path !== "string") return;
    const ctrl = new AbortController();
    inflight.set(msg.id, ctrl);
    const init = {
      method: (msg.method || "POST").toUpperCase(),
      body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
      signal: ctrl.signal,
    };
    let reason: "eof" | "aborted" | "error" = "eof";
    let errMsg: string | undefined;
    try {
      for await (const chunk of opts.streamProxy(opts.getBaseUrl() + msg.path, init)) {
        if (ctrl.signal.aborted) break;
        post({ type: "tk:chunk", id: msg.id, data: chunk.data });
      }
      if (ctrl.signal.aborted) reason = "aborted";
    } catch (err) {
      if (ctrl.signal.aborted) {
        reason = "aborted";
      } else {
        reason = "error";
        errMsg = (err as Error).message;
      }
    } finally {
      inflight.delete(msg.id);
      const payload: { type: string; id: number; reason: string; error?: string } = {
        type: "tk:done",
        id: msg.id,
        reason,
      };
      if (errMsg) payload.error = errMsg;
      post(payload);
    }
  }

  return {
    async handle(msg, post) {
      if (msg.type === "tk:req") return handleReq(msg, post);
      if (msg.type === "tk:stream") return handleStream(msg, post);
      if (msg.type === "tk:abort" && typeof msg.id === "number") {
        const c = inflight.get(msg.id);
        if (c) c.abort();
        return;
      }
    },
    disposeAll() {
      for (const c of inflight.values()) c.abort();
      inflight.clear();
    },
  };
}
