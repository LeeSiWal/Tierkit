import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/context-compression/estimateTokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(chars / 4)", () => {
    expect(estimateTokens("a")).toBe(1);          // ceil(1/4) = 1
    expect(estimateTokens("abcd")).toBe(1);       // ceil(4/4) = 1
    expect(estimateTokens("abcde")).toBe(2);      // ceil(5/4) = 2
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("a".repeat(101))).toBe(26);
  });

  it("counts code-like text by raw character count", () => {
    const code = "function foo() { return 42; }";
    expect(estimateTokens(code)).toBe(Math.ceil(code.length / 4));
  });
});
