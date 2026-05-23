import { describe, expect, it } from "vitest";
import { summarizeGitDiff } from "../src/digest/gitDiff.js";

const SAMPLE_DIFF = `diff --git a/src/components/AdminMenuForm.tsx b/src/components/AdminMenuForm.tsx
index e69de29..b6fc4c6 100644
--- a/src/components/AdminMenuForm.tsx
+++ b/src/components/AdminMenuForm.tsx
@@ -1,5 +1,12 @@ export function AdminMenuForm() {
-export const oldName = "x";
+export const newName = "y";
+
+export function renderCategoryTab() {
+  return null;
+}
diff --git a/src/store/menuStore.ts b/src/store/menuStore.ts
index 1111111..2222222 100644
--- a/src/store/menuStore.ts
+++ b/src/store/menuStore.ts
@@ -10,3 +10,7 @@
+import { something } from "./util";
+
+const newConstant = 42;
diff --git a/src/legacy/old.ts b/src/legacy/old.ts
deleted file mode 100644
index abc..0000000
--- a/src/legacy/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const old = 1;
-export const stale = 2;
-export const gone = 3;
diff --git a/docs/README.md b/docs/manual.md
similarity index 95%
rename from docs/README.md
rename to docs/manual.md
`;

describe("summarizeGitDiff", () => {
  it("classifies added/modified/deleted/renamed", async () => {
    const d = await summarizeGitDiff("/fake/path", {
      diffRunner: async () => ({ ok: true, diff: SAMPLE_DIFF }),
    });
    expect(d.modifiedFiles).toContain("src/components/AdminMenuForm.tsx");
    expect(d.modifiedFiles).toContain("src/store/menuStore.ts");
    expect(d.deletedFiles).toContain("src/legacy/old.ts");
    expect(d.renamedFiles).toEqual([{ from: "docs/README.md", to: "docs/manual.md" }]);
  });

  it("counts insertions and deletions", async () => {
    const d = await summarizeGitDiff("/fake/path", {
      diffRunner: async () => ({ ok: true, diff: SAMPLE_DIFF }),
    });
    expect(d.totalInsertions).toBeGreaterThan(0);
    expect(d.totalDeletions).toBeGreaterThan(0);
  });

  it("extracts affected symbols from hunk content", async () => {
    const d = await summarizeGitDiff("/fake/path", {
      diffRunner: async () => ({ ok: true, diff: SAMPLE_DIFF }),
    });
    expect(d.affectedSymbols).toContain("newName");
    expect(d.affectedSymbols).toContain("renderCategoryTab");
    expect(d.affectedSymbols).toContain("newConstant");
  });

  it("flags possible breakages for deletes + renames", async () => {
    const d = await summarizeGitDiff("/fake/path", {
      diffRunner: async () => ({ ok: true, diff: SAMPLE_DIFF }),
    });
    const all = d.possibleBreakages.join("\n");
    expect(all).toContain("deleted");
    expect(all).toContain("renamed");
  });

  it("handles empty diff gracefully", async () => {
    const d = await summarizeGitDiff("/fake/path", {
      diffRunner: async () => ({ ok: true, diff: "" }),
    });
    expect(d.changedFiles.length).toBe(0);
    expect(d.uncertainty.length).toBeGreaterThan(0);
  });

  it("handles git runner failure", async () => {
    const d = await summarizeGitDiff("/fake/path", {
      diffRunner: async () => ({ ok: false, message: "not a git repository" }),
    });
    expect(d.uncertainty[0]).toContain("not a git repository");
  });

  it("achieves token savings vs raw diff", async () => {
    // Make a big diff with lots of context lines.
    const bigHunk = Array.from({ length: 500 }, () => "+ noisy added line").join("\n");
    const diff = `diff --git a/foo.ts b/foo.ts\nindex 1..2 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,500 @@\n${bigHunk}`;
    const d = await summarizeGitDiff("/fake/path", {
      diffRunner: async () => ({ ok: true, diff }),
    });
    expect(d.stats.savedRatio).toBeGreaterThan(0.5);
  });
});
