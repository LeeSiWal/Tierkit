import { describe, it, expect } from "vitest";
import { scoreRisk } from "../src/model/RiskScorer.js";

describe("scoreRisk — taskType weighting", () => {
  it("bare 'review' query without taskType stays low risk", () => {
    const r = scoreRisk({ task: "review this please" });
    expect(r.score).toBe(10);  // base, no keyword match
  });

  it("code-review taskType adds +20", () => {
    const r = scoreRisk({ task: "review this please", taskType: "code-review" });
    expect(r.score).toBe(30);
    expect(r.reasons.some((s) => s.includes("code-review"))).toBe(true);
  });

  it("plan taskType adds +15", () => {
    const r = scoreRisk({ task: "plan a thing", taskType: "plan" });
    expect(r.score).toBe(25);
  });

  it("refactor taskType adds +15", () => {
    const r = scoreRisk({ task: "do a refactor", taskType: "refactor" });
    // keyword "refactor" already triggers MEDIUM +15, plus taskType +15 = 40
    expect(r.score).toBe(40);
  });

  it("general taskType adds nothing", () => {
    const r = scoreRisk({ task: "hi", taskType: "general" });
    expect(r.score).toBe(10);
  });

  it("code-review + production keyword stacks", () => {
    const r = scoreRisk({ task: "review the production secret rotation", taskType: "code-review" });
    // HIGH(+30 from "production" first match) + taskType(+20) = 60
    expect(r.score).toBe(60);
  });
});
