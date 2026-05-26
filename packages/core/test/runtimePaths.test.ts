import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveRuntimeDataDir } from "../src/runtime/runtimePaths.js";

describe("resolveRuntimeDataDir", () => {
  it("returns absolute paths unchanged", () => {
    expect(resolveRuntimeDataDir("/var/lib/tierkit", "/anywhere")).toBe("/var/lib/tierkit");
  });
  it("resolves relative paths against cwd", () => {
    expect(resolveRuntimeDataDir(".tierkit/runtime", "/work/proj")).toBe(path.resolve("/work/proj", ".tierkit/runtime"));
  });
});
