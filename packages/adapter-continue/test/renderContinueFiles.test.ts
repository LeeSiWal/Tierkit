import { describe, it, expect } from "vitest";
import {
  renderPermissionContract,
  renderPluginRules,
  renderPluginModes,
  renderPluginPrompts,
} from "../src/renderContinueFiles.js";
import { makePlugin } from "./fixtures.js";

describe("renderPermissionContract", () => {
  it("emits a 00-<id>-permission.md file with MAY and MUST NOT sections", () => {
    const plugin = makePlugin({ id: "p", permissions: { readFiles: true } });
    const r = renderPermissionContract(plugin.manifest);
    expect(r.path).toBe(".continue/rules/00-p-permission.md");
    expect(r.contents).toContain("# Permission contract — p");
    expect(r.contents).toContain("## You MAY");
    expect(r.contents).toContain("## You MUST NOT");
    expect(r.contents).toContain("Run shell commands of any kind.");
  });
});

describe("renderPluginRules", () => {
  it("emits 10-<id>-rule-<slug>.md per rule", () => {
    const plugin = makePlugin({
      id: "p",
      rules: [{ file: "rules/local-first.md", body: "Stay local." }],
    });
    const r = renderPluginRules(plugin);
    expect(r.files[0]!.path).toBe(".continue/rules/10-p-rule-local-first.md");
  });
});

describe("renderPluginModes", () => {
  it("emits 20-<id>-mode-<slug>.md per mode as persona rules", () => {
    const plugin = makePlugin({
      id: "p",
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
    expect(r.files[0]!.path).toBe(".continue/rules/20-p-mode-reviewer.md");
    expect(r.files[0]!.contents).toContain("# Persona: Reviewer");
    expect(r.files[0]!.contents).toContain("Continue has no first-class custom modes");
  });
});

describe("renderPluginPrompts", () => {
  it("emits .prompt files (Continue's native slash command format)", () => {
    const plugin = makePlugin({
      id: "p",
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
    const r = renderPluginPrompts(plugin);
    expect(r.files[0]!.path).toBe(".continue/prompts/p-brainstorm.prompt");
    expect(r.files[0]!.contents).toMatch(/^---\nname: p-brainstorm/);
    expect(r.files[0]!.contents).toContain("Workflow body.");
  });

  it("warns and skips when prompt file is missing", () => {
    const plugin = makePlugin({
      id: "p",
      commands: [
        {
          name: "x",
          description: "x",
          category: "misc",
          file: "commands/x.md",
          body: "x",
        },
      ],
    });
    plugin.files.delete("commands/x.md");
    const r = renderPluginPrompts(plugin);
    expect(r.files).toEqual([]);
    expect(r.warnings.some((w) => w.message.includes("commands/x.md"))).toBe(true);
  });
});
