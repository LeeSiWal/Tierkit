import { describe, expect, it } from "vitest";
import { compressJson } from "../src/digest/jsonCompress.js";

describe("compressJson", () => {
  it("preserves field paths for a simple object", () => {
    const d = compressJson(JSON.stringify({ a: 1, b: { c: "hi" } }));
    expect(d.fieldPaths).toContain("a");
    expect(d.fieldPaths).toContain("b");
    expect(d.fieldPaths).toContain("b.c");
  });

  it("collapses large arrays to length + sample shape", () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const json = JSON.stringify(big);
    const d = compressJson(json);
    expect(d.summaryMd).toContain("length 1000");
    expect(d.stats.savedRatio).toBeGreaterThan(0.5);
  });

  it("truncates long strings", () => {
    const long = "x".repeat(500);
    const d = compressJson(JSON.stringify({ key: long }), { maxStringLen: 50 });
    expect(d.summaryMd).toContain("truncated");
    expect(d.stats.afterChars).toBeLessThan(d.stats.beforeChars);
  });

  it("handles invalid JSON without throwing", () => {
    const d = compressJson("{ not valid json,,,}");
    expect(d.uncertainty[0]).toMatch(/not valid JSON/i);
  });

  it("respects maxDepth", () => {
    const deep: any = {};
    let cur = deep;
    for (let i = 0; i < 20; i += 1) {
      cur.next = {};
      cur = cur.next;
    }
    const d = compressJson(JSON.stringify(deep), { maxDepth: 3 });
    expect(d.summaryMd).toContain("<deep>");
  });

  it("flags envelope mismatch heuristic", () => {
    const d = compressJson(JSON.stringify({ success: true, error: null }));
    expect(d.possibleMismatches.length).toBeGreaterThan(0);
  });

  it("returns verdict not-evaluated", () => {
    const d = compressJson("{}");
    expect(d.verdict).toBe("not-evaluated");
  });
});
