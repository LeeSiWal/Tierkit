import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

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
 *  `content-encoding` and `transfer-encoding` get rebuilt by Node; passing them
 *  through can break decoding on the Claude Code side. */
const RESPONSE_HEADER_BLOCKLIST = new Set(["content-encoding", "transfer-encoding"]);

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
