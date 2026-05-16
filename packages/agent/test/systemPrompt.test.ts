import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/systemPrompt.js";
import { DEFAULT_TOOLS } from "../src/tools/index.js";

describe("buildSystemPrompt", () => {
  it("includes role, workspace, tool catalog, and output format sections", () => {
    const sp = buildSystemPrompt({ tools: DEFAULT_TOOLS, cwd: "/tmp/example" });
    expect(sp).toContain("Tierkit Agent");
    expect(sp).toContain("Working directory: /tmp/example");
    expect(sp).toContain("# Tools");
    expect(sp).toContain("# Output Format");
    expect(sp).toContain("<task_complete>");
  });

  it("lists every tool with its parameters", () => {
    const sp = buildSystemPrompt({ tools: DEFAULT_TOOLS, cwd: "/tmp/example" });
    for (const t of DEFAULT_TOOLS) {
      expect(sp).toContain(`## ${t.name}`);
      for (const p of t.parameters) {
        expect(sp).toContain(p.name);
      }
    }
  });

  it("renders mode line when provided", () => {
    const sp = buildSystemPrompt({ tools: DEFAULT_TOOLS, cwd: "/tmp", mode: "reviewer" });
    expect(sp).toContain("Active mode: reviewer");
  });

  it("includes activeRules section when provided (for non-daemon callers)", () => {
    const sp = buildSystemPrompt({
      tools: [],
      cwd: "/tmp",
      activeRules: ["Always run tests after editing.", "Never edit .env files."],
    });
    expect(sp).toContain("# Rules");
    expect(sp).toContain("Always run tests after editing.");
    expect(sp).toContain("Never edit .env files.");
  });

  it("omits Rules section when no rules provided (daemon will inject them downstream)", () => {
    const sp = buildSystemPrompt({ tools: DEFAULT_TOOLS, cwd: "/tmp" });
    expect(sp).not.toContain("# Rules");
  });
});
