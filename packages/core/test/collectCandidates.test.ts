import { describe, expect, it } from "vitest";
import {
  collectCandidates,
  type RgRunner,
} from "../src/context-compression/collectCandidates.js";

describe("collectCandidates", () => {
  it("returns rg-missing when runner throws ENOENT", async () => {
    const rg: RgRunner = async () => {
      const e: NodeJS.ErrnoException = new Error("spawn rg ENOENT");
      e.code = "ENOENT";
      throw e;
    };
    const result = await collectCandidates({
      workspaceRoot: "/tmp/repo",
      keywords: ["foo"],
      ignoreGlobs: [],
      rg,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rg-missing");
      expect(result.message).toContain("ripgrep");
      expect(result.message).toMatch(/brew install ripgrep|apt install ripgrep|choco install ripgrep/);
    }
  });

  it("merges hits across multiple keywords by path", async () => {
    const rg: RgRunner = async (args) => {
      if (args.includes("foo")) return { code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" };
      if (args.includes("bar")) return { code: 0, stdout: "src/b.ts\nsrc/c.ts\n", stderr: "" };
      if (args.includes("--files")) return { code: 0, stdout: "src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await collectCandidates({
      workspaceRoot: "/tmp/repo",
      keywords: ["foo", "bar"],
      ignoreGlobs: [],
      rg,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byPath = new Map(result.candidates.map((c) => [c.path, c]));
      expect(byPath.get("src/a.ts")?.matchedTerms).toEqual(["foo"]);
      expect(byPath.get("src/b.ts")?.matchedTerms.sort()).toEqual(["bar", "foo"]);
      expect(byPath.get("src/c.ts")?.matchedTerms).toEqual(["bar"]);
    }
  });

  it("includes filename matches even with no content hits", async () => {
    const rg: RgRunner = async (args) => {
      if (args.includes("--files")) return { code: 0, stdout: "src/payment-utils.ts\nsrc/other.ts\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await collectCandidates({
      workspaceRoot: "/tmp/repo",
      keywords: ["payment"],
      ignoreGlobs: [],
      rg,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.candidates.map((c) => c.path);
      expect(paths).toContain("src/payment-utils.ts");
      expect(paths).not.toContain("src/other.ts");
    }
  });

  it("returns no-candidates when nothing matches", async () => {
    const rg: RgRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const result = await collectCandidates({
      workspaceRoot: "/tmp/repo",
      keywords: ["nope"],
      ignoreGlobs: [],
      rg,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("no-candidates");
      expect(result.message).toMatch(/more specific|--ignore/);
    }
  });

  it("passes ignoreGlobs as --glob '!pattern' args", async () => {
    const calls: string[][] = [];
    const rg: RgRunner = async (args) => {
      calls.push([...args]);
      if (args.includes("--files")) return { code: 0, stdout: "src/x.ts\n", stderr: "" };
      return { code: 0, stdout: "src/x.ts\n", stderr: "" };
    };
    await collectCandidates({
      workspaceRoot: "/tmp/repo",
      keywords: ["x"],
      ignoreGlobs: ["node_modules/**", "dist/**"],
      rg,
    });
    for (const args of calls) {
      expect(args).toContain("--glob");
      expect(args).toContain("!node_modules/**");
      expect(args).toContain("!dist/**");
    }
  });

  it("normalizes leading './' so content + filename passes dedupe to one entry", async () => {
    // Real rg emits `./src/x.ts` for `rg --files-with-matches ... -- kw .` and
    // `src/x.ts` for `rg --files`. Without normalization the same file would
    // land twice in the candidate map. Asserted directly here so the fix from
    // the v1.7-spike Task 9 commit can't silently regress.
    const rg: RgRunner = async (args) => {
      // content pass: rg emits ./-prefixed paths
      if (args.includes("--files-with-matches")) {
        return { code: 0, stdout: "./src/x.ts\n./src/y.ts\n", stderr: "" };
      }
      // filename listing pass: rg emits unprefixed paths
      if (args.includes("--files")) {
        return { code: 0, stdout: "src/x.ts\nsrc/y.ts\nsrc/z-foo.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await collectCandidates({
      workspaceRoot: "/tmp/repo",
      keywords: ["foo"],
      ignoreGlobs: [],
      rg,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.candidates.map((c) => c.path).sort();
      // x.ts and y.ts each appear in both passes; must collapse to ONE entry each.
      expect(paths.filter((p) => p === "src/x.ts")).toHaveLength(1);
      expect(paths.filter((p) => p === "src/y.ts")).toHaveLength(1);
      // No "./"-prefixed path leaks through.
      expect(paths.some((p) => p.startsWith("./"))).toBe(false);
      // z-foo.ts only hits via filename match.
      expect(paths).toContain("src/z-foo.ts");
    }
  });
});
