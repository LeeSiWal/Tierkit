import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import crypto from "node:crypto";

/**
 * Header allowlist for the Anthropic-passthrough proxy. Everything else
 * (host, content-length, connection, transfer-encoding, accept-encoding,
 * user-agent of the inbound request, etc.) is dropped — `fetch()` will
 * regenerate the hop-by-hop ones for the upstream call.
 */
const FORWARD_HEADER_NAMES = new Set([
  "content-type",
  "x-api-key",
  "authorization",
  "x-claude-code-session-id",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
]);
const FORWARD_HEADER_PREFIXES = ["anthropic-"];

export function pickForwardHeaders(
  reqHeaders: IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    const value = Array.isArray(v) ? v.join(",") : v;
    if (FORWARD_HEADER_NAMES.has(lower)) out[lower] = value;
    else if (FORWARD_HEADER_PREFIXES.some((p) => lower.startsWith(p))) out[lower] = value;
  }
  return out;
}

export interface ForwardOptions {
  /** Upstream Anthropic base URL. Defaults to https://api.anthropic.com. */
  upstreamBaseUrl?: string;
  /** Abort signal forwarded into fetch(). */
  signal?: AbortSignal;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

function upstreamUrl(opts: ForwardOptions, path: string): string {
  const base = opts.upstreamBaseUrl ?? process.env.TIERKIT_ANTHROPIC_UPSTREAM ?? DEFAULT_UPSTREAM;
  return base.replace(/\/$/, "") + path;
}

/** Headers we drop from the upstream response before writing to the client.
 *  Two categories:
 *
 *    - **Transport-rewrite hazards**: when we strip `content-encoding`, the
 *      original `content-length` describes compressed bytes and no longer
 *      matches what we actually write. Passing that through can make Claude
 *      Code misread the response. Same for `transfer-encoding`.
 *
 *    - **Hop-by-hop headers** (RFC 7230 §6.1): connection, keep-alive,
 *      proxy-authenticate, proxy-authorization, te, trailer, upgrade —
 *      defined as never to be forwarded by an intermediary. Node regenerates
 *      the connection ones for the new outbound response anyway. */
const RESPONSE_HEADER_BLOCKLIST = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function pickResponseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (!RESPONSE_HEADER_BLOCKLIST.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

export async function forwardMessages(
  req: IncomingMessage,
  body: Buffer,
  opts: ForwardOptions = {},
): Promise<ForwardResult> {
  const res = await fetch(upstreamUrl(opts, "/v1/messages"), {
    method: "POST",
    headers: pickForwardHeaders(req.headers),
    body,
    signal: opts.signal,
  });
  return {
    status: res.status,
    headers: pickResponseHeaders(res.headers),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

/**
 * Stream an Anthropic Messages request and pipe each SSE chunk to the client.
 * We do NOT parse events here — the spike's job is protocol-semantic
 * fidelity (event sequence + multi-turn tool_use completion), not byte-level
 * identity of TCP framing. Compression / dedupe hook into this function in
 * Phase 2 after Phase 0 confirms the protocol works.
 *
 * Two stability concerns the spike still must address:
 *   1. If the downstream client (Claude Code) disconnects, we abort the
 *      upstream fetch — otherwise the daemon keeps streaming tokens into the
 *      void, leaking memory and burning the user's API credit.
 *   2. If res.write() returns false (downstream buffer full), we await
 *      'drain' before pushing more — otherwise fast upstream + slow downstream
 *      silently drops chunks.
 */
export async function streamMessages(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  opts: ForwardOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  const signal = opts.signal ?? controller.signal;

  try {
    const upstreamRes = await fetch(upstreamUrl(opts, "/v1/messages"), {
      method: "POST",
      headers: pickForwardHeaders(req.headers),
      body,
      signal,
    });

    for (const [k, v] of Object.entries(pickResponseHeaders(upstreamRes.headers))) {
      res.setHeader(k, v);
    }
    res.statusCode = upstreamRes.status;

    if (!upstreamRes.body) {
      res.end();
      return;
    }
    const reader = upstreamRes.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const writable = res.write(Buffer.from(value));
        if (!writable) {
          await once(res, "drain");
        }
      }
    } finally {
      res.end();
    }
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}

/**
 * Phase 0 spike diagnostic helper. Returns only the *shape* of inbound auth
 * headers so Validation A (Task 10) can characterize what Claude Code is
 * actually sending without logging or persisting the verbatim token.
 *
 * Hard rule: this function must never emit any output that reveals the raw
 * token. Tests in test/anthropicGateway.test.ts assert that the JSON-
 * serialized observation does not contain known secret substrings.
 *
 * Gated by the caller. Production code paths (forwardMessages, streamMessages,
 * forwardCountTokens) do NOT call this — observation should only run when
 * TIERKIT_ANTHROPIC_SPIKE_DIAGNOSTICS=1, behind whichever logger the spike
 * operator wires up.
 */
export interface AnthropicAuthObservation {
  hasAuthorization: boolean;
  authorizationScheme: string | null;
  authorizationFingerprint: string | null;
  hasApiKey: boolean;
  apiKeyFingerprint: string | null;
}

function shortFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function observeAuthHeaders(
  headers: IncomingHttpHeaders,
): AnthropicAuthObservation {
  const authorization = Array.isArray(headers.authorization)
    ? headers.authorization[0]
    : headers.authorization;
  const apiKey = Array.isArray(headers["x-api-key"])
    ? headers["x-api-key"][0]
    : headers["x-api-key"];
  return {
    hasAuthorization: typeof authorization === "string",
    authorizationScheme:
      typeof authorization === "string"
        ? authorization.split(/\s+/, 1)[0] ?? null
        : null,
    authorizationFingerprint:
      typeof authorization === "string" ? shortFingerprint(authorization) : null,
    hasApiKey: typeof apiKey === "string",
    apiKeyFingerprint: typeof apiKey === "string" ? shortFingerprint(apiKey) : null,
  };
}

export async function forwardCountTokens(
  req: IncomingMessage,
  body: Buffer,
  opts: ForwardOptions = {},
): Promise<ForwardResult> {
  const res = await fetch(upstreamUrl(opts, "/v1/messages/count_tokens"), {
    method: "POST",
    headers: pickForwardHeaders(req.headers),
    body,
    signal: opts.signal,
  });
  return {
    status: res.status,
    headers: pickResponseHeaders(res.headers),
    body: Buffer.from(await res.arrayBuffer()),
  };
}
