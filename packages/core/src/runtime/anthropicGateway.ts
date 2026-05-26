import type { IncomingHttpHeaders } from "node:http";

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
