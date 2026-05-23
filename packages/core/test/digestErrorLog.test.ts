import { describe, expect, it } from "vitest";
import { compressErrorLog } from "../src/digest/errorLog.js";

describe("compressErrorLog", () => {
  it("extracts TypeScript errors with file:line:col", () => {
    const log = [
      "src/components/AdminMenuForm.tsx:42:13 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src/store/menuStore.ts:18:5 - error TS2304: Cannot find name 'foo'.",
      "Found 2 errors in 2 files.",
    ].join("\n");
    const d = compressErrorLog(log);
    expect(d.mainErrors.length).toBe(2);
    expect(d.mainErrors[0].filePath).toBe("src/components/AdminMenuForm.tsx");
    expect(d.mainErrors[0].line).toBe(42);
    expect(d.mainErrors[0].message).toContain("TS2345");
    expect(d.likelyFiles).toContain("src/components/AdminMenuForm.tsx");
    expect(d.likelyFiles).toContain("src/store/menuStore.ts");
  });

  it("strips node_modules stack frames by default", () => {
    const log = [
      "TypeError: foo is not a function",
      "    at Foo.bar (/Users/x/proj/src/index.ts:10:5)",
      "    at process.processTicksAndRejections (/Users/x/proj/node_modules/some-pkg/dist/index.js:42:3)",
      "    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
    ].join("\n");
    const d = compressErrorLog(log);
    const allText = JSON.stringify(d.mainErrors);
    expect(allText).toContain("/src/index.ts");
    expect(allText).not.toContain("node_modules");
  });

  it("collapses repeated identical errors with repeatedCount", () => {
    const same = "src/foo.ts:1:1 - error TS9999: same problem";
    const log = [same, same, same, same].join("\n");
    const d = compressErrorLog(log);
    expect(d.mainErrors.length).toBe(1);
    expect(d.mainErrors[0].repeatedCount).toBe(4);
  });

  it("achieves nonzero token reduction on a noisy log", () => {
    const big = Array.from({ length: 200 }, (_, i) =>
      `    at someFunc${i} (/proj/node_modules/lib/file.js:${i}:1)`,
    ).join("\n");
    const log = [
      "TypeError: x is undefined",
      "    at userCode (/proj/src/app.ts:42:5)",
      big,
    ].join("\n");
    const d = compressErrorLog(log);
    expect(d.stats.savedTokens).toBeGreaterThan(0);
    expect(d.stats.savedRatio).toBeGreaterThan(0.5);
  });

  it("flags uncertainty when no errors recognized", () => {
    const d = compressErrorLog("just some plain text with no error pattern at all");
    expect(d.mainErrors.length).toBe(0);
    expect(d.uncertainty.length).toBeGreaterThan(0);
  });

  it("parses Python tracebacks", () => {
    const log = [
      'Traceback (most recent call last):',
      '  File "/proj/src/app.py", line 42, in main',
      '    foo()',
      '  File "/proj/.venv/lib/site-packages/lib.py", line 99, in helper',
      '    pass',
      'TypeError: foo got unexpected arg',
    ].join("\n");
    const d = compressErrorLog(log);
    const text = JSON.stringify(d.mainErrors);
    expect(text).toContain("src/app.py");
    expect(text).not.toContain("site-packages");
  });

  it("returns verdict not-evaluated by default", () => {
    const d = compressErrorLog("src/foo.ts:1:1 - error TS1: x");
    expect(d.verdict).toBe("not-evaluated");
  });
});
