import { makeFailureEnvelope, type ToolResultFailure } from "./envelope.js";

/**
 * Standardized failure envelopes for cursor-related errors. Tool implementations
 * call these instead of building envelopes ad-hoc so error messages stay
 * consistent across tools.
 */

export function cursorInvalidEnvelope(tool: string, detail?: string): ToolResultFailure {
  const message = detail
    ? `cursor is invalid: ${detail}`
    : "cursor is invalid (malformed base64url or JSON shape)";
  return makeFailureEnvelope(tool, "cursor-invalid", message);
}

export function staleCursorEnvelope(
  tool: string,
  detail: string,                  // e.g. "file fileHash no longer matches"
): ToolResultFailure {
  return makeFailureEnvelope(tool, "stale-cursor", `cursor is stale: ${detail}`);
}
