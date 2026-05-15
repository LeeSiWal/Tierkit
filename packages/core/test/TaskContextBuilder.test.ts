import { describe, it, expect } from "vitest";
import { buildTaskContext } from "../src/context/TaskContextBuilder.js";

describe("buildTaskContext", () => {
  it("plan mode emits a plan-shaped system prompt", () => {
    const r = buildTaskContext({ task: "refactor auth", mode: "plan" });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.role).toBe("system");
    expect(r.messages[0]!.content).toContain("PLAN mode");
    expect(r.messages[1]!.role).toBe("user");
    expect(r.messages[1]!.content).toBe("refactor auth");
  });

  it("review mode emits a review-shaped system prompt", () => {
    const r = buildTaskContext({ task: "review the diff", mode: "review" });
    expect(r.systemPrompt).toContain("REVIEW mode");
    expect(r.systemPrompt).toContain("ship it");
  });

  it("execute mode keeps the preamble tight", () => {
    const r = buildTaskContext({ task: "rename a helper", mode: "execute" });
    expect(r.systemPrompt).toContain("EXECUTE mode");
  });

  it("prepends extraSystem before the preamble", () => {
    const r = buildTaskContext({
      task: "x",
      mode: "execute",
      extraSystem: "Plugin rule: stay local-first.",
    });
    expect(r.systemPrompt.startsWith("Plugin rule: stay local-first.")).toBe(true);
    expect(r.systemPrompt).toContain("EXECUTE mode");
  });
});
