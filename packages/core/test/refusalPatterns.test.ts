import { describe, it, expect } from "vitest";
import { REFUSAL_PATTERNS, matchesRefusal } from "../src/model/refusalPatterns.js";

describe("refusalPatterns", () => {
  const positives = [
    "I cannot help with that",
    "I can't do that, sorry",
    "I cannot provide that information",
    "I'm sorry, but I won't be able to",
    "As an AI, I don't have opinions",
    "I am unable to fulfill this request",
    "죄송합니다만 도와드릴 수 없습니다",
    "저는 그것을 할 수 없습니다",
    "할 수 없습니다",
    "거부합니다",
    "답변드릴 수 없습니다",
  ];
  const negatives = [
    "Here is the answer: cannot is a word that means unable.",
    "The user said 'I cannot' earlier in the thread.",
    "Sure, here's an example: I can help with that.",
    "이것은 'I cannot'이라는 표현을 설명합니다.",
    "할 수 있습니다",
  ];

  it("each positive fixture matches at least one pattern", () => {
    for (const s of positives) {
      expect(matchesRefusal(s), `should match: ${s}`).toBe(true);
    }
  });

  it("no negative fixture matches any pattern (head-anchored)", () => {
    for (const s of negatives) {
      expect(matchesRefusal(s), `should NOT match: ${s}`).toBe(false);
    }
  });

  it("REFUSAL_PATTERNS is a non-empty list of RegExp", () => {
    expect(REFUSAL_PATTERNS.length).toBeGreaterThan(5);
    for (const r of REFUSAL_PATTERNS) expect(r).toBeInstanceOf(RegExp);
  });
});
