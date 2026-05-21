import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveUnderWorkspace, isPathInside } from "../src/workspaceBoundary.js";

/**
 * Resolve a workspace path through its parent chain for test expectations.
 * On macOS /tmp → /private/tmp, so returned paths from resolveUnderWorkspace
 * are canonical; test expectations must match the canonical form.
 */
function resolveWorkspaceForTest(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    try {
      return path.join(fs.realpathSync(parent), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

describe("workspaceBoundary", () => {
  const workspace = path.resolve("/tmp/tierkit-wb-test");
  // On macOS /tmp is a symlink to /private/tmp; resolved paths are canonical.
  const workspaceCanonical = resolveWorkspaceForTest(workspace);

  it("resolves a relative path under workspace", () => {
    expect(resolveUnderWorkspace(workspace, "src/foo.ts"))
      .toBe(path.join(workspaceCanonical, "src/foo.ts"));
  });

  it("rejects absolute paths outside workspace", () => {
    expect(() => resolveUnderWorkspace(workspace, "/etc/passwd")).toThrow(/outside-workspace/);
  });

  it("rejects parent-traversal paths", () => {
    expect(() => resolveUnderWorkspace(workspace, "../../etc/passwd")).toThrow(/outside-workspace/);
  });

  it("accepts the workspace root itself", () => {
    expect(resolveUnderWorkspace(workspace, ".")).toBe(workspaceCanonical);
  });

  it("isPathInside returns false for sibling dirs", () => {
    expect(isPathInside(workspace, path.join(workspace + "-sibling", "x"))).toBe(false);
    expect(isPathInside(workspace, path.join(workspace, "x"))).toBe(true);
    expect(isPathInside(workspace, workspace)).toBe(true);
  });

  describe("symlink escape prevention", () => {
    let tmpWorkspace: string;
    let tmpOutside: string;

    afterEach(() => {
      // Clean up temp dirs
      for (const dir of [tmpWorkspace, tmpOutside]) {
        if (dir) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
        }
      }
    });

    it("rejects a symlink inside the workspace that points outside", () => {
      tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "tierkit-wb-"));
      tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), "tierkit-outside-"));

      // Create a symlink inside the workspace that points to the outside dir
      const symlinkPath = path.join(tmpWorkspace, "escape-link");
      fs.symlinkSync(tmpOutside, symlinkPath);

      // Resolving through the symlink must be rejected
      expect(() => resolveUnderWorkspace(tmpWorkspace, "escape-link")).toThrow(/outside-workspace/);
    });

    it("accepts a symlink inside the workspace that points to another workspace path", () => {
      tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "tierkit-wb-"));
      // Create a real dir inside the workspace
      const realDir = path.join(tmpWorkspace, "real-dir");
      fs.mkdirSync(realDir);

      // Create a symlink inside the workspace pointing to the real dir (still inside)
      const symlinkPath = path.join(tmpWorkspace, "safe-link");
      fs.symlinkSync(realDir, symlinkPath);

      // This should succeed and return the realpath of the target
      const result = resolveUnderWorkspace(tmpWorkspace, "safe-link");
      expect(result).toBe(fs.realpathSync(realDir));
    });
  });
});
