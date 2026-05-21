import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveUnderWorkspace, isPathInside } from "../src/workspaceBoundary.js";

describe("workspaceBoundary", () => {
  const workspace = path.resolve("/tmp/tierkit-wb-test");

  it("resolves a relative path under workspace", () => {
    expect(resolveUnderWorkspace(workspace, "src/foo.ts"))
      .toBe(path.join(workspace, "src/foo.ts"));
  });

  it("rejects absolute paths outside workspace", () => {
    expect(() => resolveUnderWorkspace(workspace, "/etc/passwd")).toThrow(/outside-workspace/);
  });

  it("rejects parent-traversal paths", () => {
    expect(() => resolveUnderWorkspace(workspace, "../../etc/passwd")).toThrow(/outside-workspace/);
  });

  it("accepts the workspace root itself", () => {
    expect(resolveUnderWorkspace(workspace, ".")).toBe(workspace);
  });

  it("isPathInside returns false for sibling dirs", () => {
    expect(isPathInside(workspace, path.join(workspace + "-sibling", "x"))).toBe(false);
    expect(isPathInside(workspace, path.join(workspace, "x"))).toBe(true);
    expect(isPathInside(workspace, workspace)).toBe(true);
  });
});
