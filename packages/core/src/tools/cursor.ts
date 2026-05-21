/**
 * Opaque base64url-encoded JSON cursors for tool result pagination.
 *
 * The model never parses these; tool implementations encode/decode them via
 * this module. v0.16 uses raw base64url(JSON) — v0.17 may add HMAC for
 * tamper detection if needed.
 */

export class CursorDecodeError extends Error {
  code = "cursor-invalid";
  constructor(message: string) {
    super(message);
    this.name = "CursorDecodeError";
  }
}

export interface ReadFileCursor {
  tool: "read_file";
  path: string;
  nextStartLine: number;
  maxLines: number;
  fileHash: string;          // REQUIRED — sha256 of full file at issue time
  createdAt: string;         // ISO timestamp
}

export interface ListFilesCursor {
  tool: "list_files";
  path: string;
  recursive: boolean;
  nextIndex: number;
  maxEntries: number;
  createdAt: string;
}

export interface SearchFilesCursor {
  tool: "search_files";
  pattern: string;
  path: string;
  nextMatchIndex: number;
  maxMatches: number;
  createdAt: string;
}

export type AnyCursor = ReadFileCursor | ListFilesCursor | SearchFilesCursor;

/**
 * Encode an opaque cursor: base64url(JSON.stringify(cursor)).
 * Stripped padding. Safe in URLs, query strings, JSON values.
 */
export function encodeCursor(cursor: object): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor. Throws CursorDecodeError on:
 *   - empty / malformed base64url
 *   - decoded text that is not valid JSON
 *   - decoded JSON that is not an object (string, number, array)
 *
 * Does NOT validate the cursor's per-field shape — callers do that against
 * their tool-specific cursor type.
 */
export function decodeCursor<T extends object = AnyCursor>(encoded: string): T {
  if (!encoded || typeof encoded !== "string") {
    throw new CursorDecodeError("cursor is empty or not a string");
  }
  let raw: string;
  try {
    raw = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new CursorDecodeError("cursor is not valid base64url");
  }
  if (!raw) {
    throw new CursorDecodeError("cursor decoded to an empty string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CursorDecodeError("cursor is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CursorDecodeError("cursor is not a JSON object");
  }
  return parsed as T;
}
