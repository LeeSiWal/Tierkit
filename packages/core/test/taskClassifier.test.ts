import { describe, it, expect } from "vitest";
import { classifyTask, TASK_TYPES } from "../src/model/TaskClassifier.js";

describe("TaskClassifier", () => {
  const cases: Array<[string, ReturnType<typeof classifyTask>]> = [
    ["please review my code", "code-review"],
    ["코드 리뷰 부탁해", "code-review"],
    ["refactor this function", "refactor"],
    ["리팩토링해줘", "refactor"],
    ["summarize this article", "summarize"],
    ["요약해줘", "summarize"],
    ["TLDR for the meeting notes", "summarize"],
    ["translate to korean", "translate"],
    ["번역해", "translate"],
    ["plan the migration", "plan"],
    ["design a new schema", "plan"],
    ["계획을 세워줘", "plan"],
    ["write a function that adds two numbers", "code-generation"],
    ["implement quicksort", "code-generation"],
    ["구현해줘", "code-generation"],
    ["", "general"],
    ["what time is it", "general"],
  ];

  for (const [input, expected] of cases) {
    it(`classifies "${input}" as ${expected}`, () => {
      expect(classifyTask(input)).toBe(expected);
    });
  }

  it("exports a TASK_TYPES tuple", () => {
    expect(TASK_TYPES).toContain("general");
    expect(TASK_TYPES).toContain("code-review");
  });

  it("prefers higher-specificity match when multiple keywords are present", () => {
    // 'review' is more specific than 'write' if both appear, code-review wins.
    expect(classifyTask("write a review of this code")).toBe("code-review");
  });
});
