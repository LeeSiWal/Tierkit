import { describe, expect, it } from "vitest";
import { compressTestOutput } from "../src/digest/testOutput.js";

describe("compressTestOutput", () => {
  it("counts passed vitest cases", () => {
    const log = [
      "✓ should add 1 + 1 = 2",
      "✓ should subtract",
      "✓ should multiply",
    ].join("\n");
    const d = compressTestOutput(log);
    expect(d.passedCount).toBe(3);
    expect(d.failedCount).toBe(0);
    expect(d.failedCases.length).toBe(0);
  });

  it("extracts vitest failures with suite > caseName", () => {
    const log = [
      "✓ passes one",
      "× MyComponent > renders when category empty",
      "    Expected: 'visible'",
      "    Received: 'hidden'",
      "    at Object.<anonymous> (/proj/src/components/MyComponent.test.tsx:42:13)",
      "    at process.processTicksAndRejections (node:internal/modules/cjs/loader:42:3)",
    ].join("\n");
    const d = compressTestOutput(log);
    expect(d.passedCount).toBe(1);
    expect(d.failedCount).toBe(1);
    expect(d.failedCases.length).toBe(1);
    expect(d.failedCases[0].suite).toBe("MyComponent");
    expect(d.failedCases[0].caseName).toContain("renders when category empty");
    expect(d.failedCases[0].expected).toContain("visible");
    expect(d.failedCases[0].received).toContain("hidden");
    expect(d.failedCases[0].likelyCause).toBeDefined();
    expect(d.likelyFiles.some((f) => f.includes("MyComponent.test.tsx"))).toBe(true);
  });

  it("drops node_modules + node:internal frames", () => {
    const log = [
      "× foo > bar",
      "    Expected: 1",
      "    Received: 2",
      "    at userCode (/proj/src/app.ts:10:5)",
      "    at process.tick (node:internal/modules/cjs/loader:1234:14)",
      "    at fn (/proj/node_modules/some-pkg/dist/index.js:99:3)",
    ].join("\n");
    const d = compressTestOutput(log);
    expect(d.failedCases.length).toBe(1);
    const allFrames = d.failedCases[0].relevantFrames.join("\n");
    expect(allFrames).toContain("/src/app.ts");
    expect(allFrames).not.toContain("node_modules");
    expect(allFrames).not.toContain("node:internal");
  });

  it("parses jest-style ● failures", () => {
    const log = [
      "● Suite name › nested case",
      "    expected: 'a'",
      "    received: 'b'",
      "    at /proj/src/foo.ts:5:1",
    ].join("\n");
    const d = compressTestOutput(log);
    expect(d.failedCount).toBe(1);
    expect(d.failedCases[0].suite).toContain("Suite name");
    expect(d.failedCases[0].caseName).toContain("nested case");
  });

  it("parses pytest FAILED summary lines", () => {
    const log = [
      "tests/test_app.py::test_addition PASSED",
      "FAILED tests/test_app.py::test_subtraction - assert 1 == 2",
    ].join("\n");
    const d = compressTestOutput(log);
    expect(d.failedCount).toBe(1);
    expect(d.failedCases[0].caseName).toBe("test_subtraction");
    expect(d.likelyFiles).toContain("tests/test_app.py");
  });

  it("achieves token reduction on noisy log", () => {
    const noise = Array.from({ length: 300 }, (_, i) => `✓ passing test ${i}`).join("\n");
    const log = [
      noise,
      "× failing > test",
      "    Expected: 1",
      "    Received: 2",
      "    at /proj/src/app.ts:42:5",
    ].join("\n");
    const d = compressTestOutput(log);
    expect(d.passedCount).toBe(300);
    expect(d.stats.savedRatio).toBeGreaterThan(0.5);
  });

  it("flags uncertainty on unrecognized format", () => {
    const d = compressTestOutput("totally random unrelated text");
    expect(d.uncertainty.length).toBeGreaterThan(0);
  });
});
