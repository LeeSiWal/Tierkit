import { describe, it, expect } from "vitest";
import {
  renderPluginCommands,
  renderPluginModes,
  renderPluginRules,
} from "../src/renderClineFiles.js";
import { makePlugin } from "./fixtures.js";

describe("renderPluginRules", () => {
  it("emits one .clinerules file per rule with 10- prefix", () => {
    const plugin = makePlugin({
      id: "sp",
      rules: [
        { file: "rules/local-first.md", body: "# Rule: local-first\nStay local." },
        { file: "rules/no-prod.md", body: "# Rule: no prod\nDon't touch prod." },
      ],
    });
    const r = renderPluginRules(plugin);
    expect(r.files.map((f) => f.path).sort()).toEqual([
      ".clinerules/10-sp-rule-local-first.md",
      ".clinerules/10-sp-rule-no-prod.md",
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("warns when a rule references a missing file", () => {
    const plugin = makePlugin({
      id: "sp",
      rules: [{ file: "rules/missing.md", body: "x" }],
    });
    plugin.files.delete("rules/missing.md");
    const r = renderPluginRules(plugin);
    expect(r.files).toEqual([]);
    expect(r.warnings.some((w) => w.message.includes("rules/missing.md"))).toBe(true);
  });
});

describe("renderPluginModes", () => {
  it("emits persona rules with 20- prefix and notes Cline has no first-class modes", () => {
    const plugin = makePlugin({
      id: "sp",
      modes: [
        {
          id: "reviewer",
          name: "Reviewer",
          tools: ["read"],
          role: "reviewer",
          file: "modes/reviewer.md",
          body: "# Reviewer\n\nReview diffs.\n",
        },
      ],
    });
    const r = renderPluginModes(plugin);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.path).toBe(".clinerules/20-sp-mode-reviewer.md");
    expect(r.files[0]!.contents).toContain("# Persona: Reviewer");
    expect(r.files[0]!.contents).toContain("Cline has no first-class custom modes");
    expect(r.files[0]!.contents).toContain("Review diffs.");
  });

  it("includes declared tools as intentions only", () => {
    const plugin = makePlugin({
      id: "sp",
      modes: [
        {
          id: "p",
          name: "P",
          tools: ["read", "edit"],
          role: "r",
          file: "modes/p.md",
          body: "body",
        },
      ],
    });
    const r = renderPluginModes(plugin);
    expect(r.files[0]!.contents).toContain("`read`, `edit`");
    expect(r.files[0]!.contents).toContain("intentions");
  });
});

describe("renderPluginCommands", () => {
  it("emits command rules with 30- prefix and slash-style heading", () => {
    const plugin = makePlugin({
      id: "sp",
      commands: [
        {
          name: "brainstorm",
          description: "Plan first",
          category: "planning",
          file: "commands/brainstorm.md",
          body: "Workflow body.",
        },
      ],
    });
    const r = renderPluginCommands(plugin);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.path).toBe(".clinerules/30-sp-command-brainstorm.md");
    expect(r.files[0]!.contents).toContain("# Command: /brainstorm");
    expect(r.files[0]!.contents).toContain("Cline does not register slash commands");
    expect(r.files[0]!.contents).toContain("Plan first");
  });
});
