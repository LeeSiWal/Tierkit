import { describe, it, expect } from "vitest";
import { estimateTokensFromText } from "../src/model/providers/estimateTokens.js";

describe("estimateTokensFromText (CJK-aware)", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokensFromText("")).toBe(0);
  });

  it("returns at least 1 for any non-empty input", () => {
    expect(estimateTokensFromText("a")).toBeGreaterThanOrEqual(1);
  });

  it("ASCII English ≈ ceil(length / 4)", () => {
    const s = "hello world this is a longer line of english text";
    expect(estimateTokensFromText(s)).toBe(Math.max(1, Math.ceil(s.length / 4)));
  });

  it("pure Korean ≈ ceil(length / 2)", () => {
    const s = "안녕하세요반갑습니다";
    expect(estimateTokensFromText(s)).toBe(Math.ceil(s.length / 2));
  });

  it("weights CJK and non-CJK together", () => {
    const eng = "hello world";
    const kor = "안녕";
    const mix = eng + kor;
    const expected = Math.max(1, Math.ceil(kor.length / 2 + eng.length / 4));
    expect(estimateTokensFromText(mix)).toBe(expected);
  });

  it("handles Japanese hiragana/katakana", () => {
    expect(estimateTokensFromText("こんにちは")).toBeGreaterThan(0);
    expect(estimateTokensFromText("カタカナ")).toBeGreaterThan(0);
  });
});
