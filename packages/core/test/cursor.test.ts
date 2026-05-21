import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  type ReadFileCursor,
  type ListFilesCursor,
  type SearchFilesCursor,
  CursorDecodeError,
} from "../src/tools/cursor.js";

const sampleReadCursor: ReadFileCursor = {
  tool: "read_file",
  path: "src/foo.ts",
  nextStartLine: 301,
  maxLines: 300,
  fileHash: "sha256:abc",
  createdAt: "2026-05-21T00:00:00.000Z",
};

describe("cursor encode/decode", () => {
  it("round-trips a ReadFileCursor", () => {
    const encoded = encodeCursor(sampleReadCursor);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded).not.toContain("+");      // base64url, not base64
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");      // padding stripped

    const decoded = decodeCursor<ReadFileCursor>(encoded);
    expect(decoded).toEqual(sampleReadCursor);
  });

  it("decodeCursor throws CursorDecodeError on garbage input", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(CursorDecodeError);
    expect(() => decodeCursor("")).toThrow(CursorDecodeError);
    expect(() => decodeCursor("aGVsbG8=")).toThrow(CursorDecodeError);  // valid base64url but not JSON
  });

  it("decodeCursor throws CursorDecodeError on JSON that's not an object", () => {
    const notObject = Buffer.from(JSON.stringify("string-not-object"), "utf8")
      .toString("base64url");
    expect(() => decodeCursor(notObject)).toThrow(CursorDecodeError);
  });

  it("round-trips a ListFilesCursor", () => {
    const cursor: ListFilesCursor = {
      tool: "list_files",
      path: ".",
      recursive: true,
      nextIndex: 200,
      maxEntries: 200,
      createdAt: "2026-05-21T00:00:00.000Z",
    };
    expect(decodeCursor<ListFilesCursor>(encodeCursor(cursor))).toEqual(cursor);
  });

  it("round-trips a SearchFilesCursor", () => {
    const cursor: SearchFilesCursor = {
      tool: "search_files",
      pattern: "foo",
      path: ".",
      nextMatchIndex: 50,
      maxMatches: 50,
      createdAt: "2026-05-21T00:00:00.000Z",
    };
    expect(decodeCursor<SearchFilesCursor>(encodeCursor(cursor))).toEqual(cursor);
  });

  it("decoded cursor preserves all extra fields a future version might add", () => {
    const future = { ...sampleReadCursor, hmac: "future-field" };
    const decoded = decodeCursor<typeof future>(encodeCursor(future));
    expect(decoded.hmac).toBe("future-field");
  });
});
