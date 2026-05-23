import { describe, expect, it } from "vitest";
import { cleanContext } from "../src/digest/cleanContext.js";

describe("cleanContext", () => {
  it("removes passing test lines", () => {
    const input = [
      "✓ test 1",
      "✓ test 2",
      "× failing > case",
      "✓ test 3",
    ].join("\n");
    const c = cleanContext(input);
    expect(c.cleaned).not.toContain("test 1");
    expect(c.cleaned).not.toContain("test 2");
    expect(c.cleaned).toContain("failing");
    expect(c.removedHints.join(" ")).toContain("passing-test");
  });

  it("removes vendor stack frames", () => {
    const input = [
      "Error: x",
      "    at userFn (/proj/src/app.ts:10:5)",
      "    at lib (/proj/node_modules/foo/bar.js:99:1)",
      "    at internal (node:internal/modules/cjs/loader:1234:14)",
    ].join("\n");
    const c = cleanContext(input);
    expect(c.cleaned).toContain("userFn");
    expect(c.cleaned).not.toContain("node_modules");
    expect(c.cleaned).not.toContain("node:internal");
  });

  it("collapses repeated consecutive lines", () => {
    const input = Array.from({ length: 10 }, () => "same line").join("\n");
    const c = cleanContext(input);
    const occurrences = (c.cleaned.match(/same line/g) || []).length;
    expect(occurrences).toBeLessThan(10);
    expect(c.cleaned).toContain("[repeated]");
  });

  it("preserves warnings", () => {
    const input = [
      "✓ passed",
      "Warning: deprecated API used in src/foo.ts",
      "✓ passed",
    ].join("\n");
    const c = cleanContext(input);
    expect(c.preservedWarnings.length).toBeGreaterThan(0);
    expect(c.cleaned).toContain("Warning");
  });

  it("achieves nonzero token reduction on noisy log", () => {
    const noise = [
      ...Array.from({ length: 100 }, (_, i) => `✓ test ${i}`),
      ...Array.from({ length: 50 }, (_, i) => `    at fn${i} (/proj/node_modules/lib.js:${i}:1)`),
      "Actual error: x is undefined",
    ];
    const c = cleanContext(noise.join("\n"));
    expect(c.stats.savedRatio).toBeGreaterThan(0.5);
    expect(c.cleaned).toContain("Actual error");
  });

  it("allows opting out via keepPassingTests", () => {
    const input = ["✓ test 1", "✓ test 2"].join("\n");
    const c = cleanContext(input, { keepPassingTests: true });
    expect(c.cleaned).toContain("test 1");
  });
});
