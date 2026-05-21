import type { ToolResult } from "../types.js";

/**
 * Wrap a tool-result-envelope.v1 object as a Tierkit Agent ToolResult.
 *
 * The Agent's ToolResult interface is `{ ok, content: string }`, so envelope
 * objects get JSON-serialized exactly once into `content`. The runtime later
 * passes `content` back to the model verbatim — the model parses it as JSON
 * per the system prompt's envelope-continuation contract.
 *
 * Used by every Agent tool that returns the v0.16 envelope (read_file,
 * list_files, search_files, execute_command).
 */
export function envelopeToString(env: object): ToolResult {
  return { ok: (env as { ok: boolean }).ok, content: JSON.stringify(env) };
}
