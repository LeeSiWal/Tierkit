import { describe, it, expect } from "vitest";
import { encodeCwdForClaudeProjects } from "../src/usecases/listClaudeSessions.js";

describe("encodeCwdForClaudeProjects", () => {
  it("replaces / with -", () => {
    expect(encodeCwdForClaudeProjects("/Users/siwal/code/Tierkit"))
      .toBe("-Users-siwal-code-Tierkit");
  });

  it("replaces . with -", () => {
    expect(encodeCwdForClaudeProjects("/Users/siwal/code/Tierkit/.claude/worktrees/feat/v0.13/sub"))
      .toBe("-Users-siwal-code-Tierkit--claude-worktrees-feat-v0-13-sub");
  });

  it("handles trailing slash by leaving a trailing dash", () => {
    expect(encodeCwdForClaudeProjects("/Users/siwal/")).toBe("-Users-siwal-");
  });

  it("handles repeated dots and slashes", () => {
    expect(encodeCwdForClaudeProjects("/a/./b..c"))
      .toBe("-a---b--c");
  });

  it("returns empty string for empty string input", () => {
    expect(encodeCwdForClaudeProjects("")).toBe("");
  });
});
