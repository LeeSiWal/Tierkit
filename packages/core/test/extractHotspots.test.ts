import { describe, expect, it } from "vitest";
import { extractHotspots } from "../src/context-compression/extractHotspots.js";

describe("extractHotspots", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

  it("returns no hotspots when no keyword matches", () => {
    const result = extractHotspots(lines(20), ["nonexistent"], { maxHotspots: 3, contextLines: 2 });
    expect(result.hotspots).toEqual([]);
    expect(result.omittedLineRanges).toEqual([[1, 20]]);
  });

  it("builds a ± contextLines window around a single match", () => {
    const src = ["a", "b", "FOO match here", "d", "e", "f"].join("\n");
    const result = extractHotspots(src, ["foo"], { maxHotspots: 1, contextLines: 1 });
    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspots[0].startLine).toBe(2);
    expect(result.hotspots[0].endLine).toBe(4);
    expect(result.hotspots[0].matchedTerms).toContain("foo");
    expect(result.hotspots[0].code).toBe("b\nFOO match here\nd");
  });

  it("merges adjacent / overlapping windows", () => {
    const src = ["a", "b", "FOO", "c", "BAR", "d", "e"].join("\n");
    const result = extractHotspots(src, ["foo", "bar"], { maxHotspots: 5, contextLines: 2 });
    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspots[0].startLine).toBe(1);
    expect(result.hotspots[0].endLine).toBe(7);
    expect(result.hotspots[0].matchedTerms.sort()).toEqual(["bar", "foo"]);
  });

  it("caps at maxHotspots, keeping highest-density windows", () => {
    const src = [
      "FOO", "x", "x", "x", "x", "x", "x", "x", "x", "x",  // 1: 1 match
      "BAR", "BAR", "x", "x", "x", "x", "x", "x", "x", "x",  // 2: 2 matches
      "BAZ", "x", "x", "x", "x", "x", "x", "x", "x", "x",   // 3: 1 match
    ].join("\n");
    const result = extractHotspots(src, ["foo", "bar", "baz"], { maxHotspots: 2, contextLines: 1 });
    expect(result.hotspots).toHaveLength(2);
    expect(result.hotspots.some((h) => h.matchedTerms.includes("bar"))).toBe(true);
  });

  it("computes omittedLineRanges as the complement of selected hotspots", () => {
    const src = ["a", "b", "FOO", "d", "e", "f", "g"].join("\n");
    const result = extractHotspots(src, ["foo"], { maxHotspots: 1, contextLines: 1 });
    expect(result.hotspots[0].startLine).toBe(2);
    expect(result.hotspots[0].endLine).toBe(4);
    expect(result.omittedLineRanges).toEqual([[1, 1], [5, 7]]);
  });

  it("clamps window to file bounds", () => {
    const src = ["FOO", "b", "c"].join("\n");
    const result = extractHotspots(src, ["foo"], { maxHotspots: 1, contextLines: 5 });
    expect(result.hotspots[0].startLine).toBe(1);
    expect(result.hotspots[0].endLine).toBe(3);
  });

  it("matches case-insensitively", () => {
    const src = "Foo bar\nFOO again\nfoo lowercase";
    const result = extractHotspots(src, ["foo"], { maxHotspots: 5, contextLines: 0 });
    expect(result.hotspots.length).toBeGreaterThan(0);
  });
});
