import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import { resolveUnder, isWithin, PathTraversalError } from "../src/fs/safePath.js";

const base = path.join(os.tmpdir(), "tierkit-safepath-test-base");

describe("resolveUnder", () => {
  it("resolves a simple relative path inside base", () => {
    const result = resolveUnder(base, "commands/brainstorm.md");
    expect(result).toBe(path.resolve(base, "commands/brainstorm.md"));
  });

  it("rejects parent traversal", () => {
    expect(() => resolveUnder(base, "../escape.txt")).toThrow(PathTraversalError);
  });

  it("rejects deeply nested traversal", () => {
    expect(() => resolveUnder(base, "a/b/../../../escape.txt")).toThrow(PathTraversalError);
  });

  it("rejects absolute paths", () => {
    expect(() => resolveUnder(base, "/etc/passwd")).toThrow(PathTraversalError);
  });

  it("rejects empty string", () => {
    expect(() => resolveUnder(base, "")).toThrow(PathTraversalError);
  });

  it("permits paths that cancel out and stay inside", () => {
    const result = resolveUnder(base, "a/../b.txt");
    expect(result).toBe(path.resolve(base, "b.txt"));
  });
});

describe("isWithin", () => {
  it("returns true for nested child", () => {
    expect(isWithin(base, path.join(base, "child", "file.txt"))).toBe(true);
  });

  it("returns true for the base itself", () => {
    expect(isWithin(base, base)).toBe(true);
  });

  it("returns false for sibling directory", () => {
    expect(isWithin(base, path.join(base, "..", "sibling"))).toBe(false);
  });
});
