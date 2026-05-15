import { describe, it, expect } from "vitest";
import { parse as yamlParse } from "yaml";
import { ContinueAdapter } from "../src/ContinueAdapter.js";
import { makeConfig, makePlugin } from "./fixtures.js";

function fullPlugin() {
  return makePlugin({
    id: "superpowers-free",
    name: "Superpowers Free",
    permissions: { readFiles: true, editFiles: true },
    commands: [
      {
        name: "brainstorm",
        description: "Plan first",
        category: "planning",
        file: "commands/brainstorm.md",
        body: "Body.",
      },
    ],
    modes: [
      {
        id: "reviewer",
        name: "Reviewer",
        tools: ["read"],
        role: "reviewer",
        file: "modes/reviewer.md",
        body: "# Reviewer\n\nReview.\n",
      },
    ],
    rules: [{ file: "rules/local-first.md", body: "Stay local." }],
    mcp: { file: "mcp/servers.json", body: '{"mcpServers": {}}' },
  });
}

describe("ContinueAdapter", () => {
  it("emits config.yaml with models populated from tierkit config", async () => {
    const adapter = new ContinueAdapter();
    const result = await adapter.export({
      plugins: [fullPlugin()],
      outDir: "/ignored",
      config: makeConfig(),
    });
    const cfg = result.files.find((f) => f.path === ".continue/config.yaml");
    expect(cfg).toBeDefined();
    const parsed = yamlParse(cfg!.contents);
    expect(parsed.models).toHaveLength(3);
  });

  it("emits permission/rule/mode files under .continue/rules/", async () => {
    const adapter = new ContinueAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toContain(".continue/rules/00-superpowers-free-permission.md");
    expect(paths).toContain(".continue/rules/10-superpowers-free-rule-local-first.md");
    expect(paths).toContain(".continue/rules/20-superpowers-free-mode-reviewer.md");
  });

  it("emits prompts under .continue/prompts/ as .prompt files (native slash commands)", async () => {
    const adapter = new ContinueAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    const prompt = result.files.find(
      (f) => f.path === ".continue/prompts/superpowers-free-brainstorm.prompt",
    );
    expect(prompt).toBeDefined();
    expect(prompt!.contents).toMatch(/^---\nname: superpowers-free-brainstorm/);
  });

  it("emits MCP staging file and warns about non-auto-registration", async () => {
    const adapter = new ContinueAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    const mcp = result.files.find((f) => f.path === ".continue/mcp/superpowers-free.json");
    expect(mcp).toBeDefined();
    expect(
      result.warnings.some((w) => w.message.includes("Continue will NOT auto-register")),
    ).toBe(true);
  });

  it("TIERKIT.md notes when no tierkit config was supplied", async () => {
    const adapter = new ContinueAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    const readme = result.files.find((f) => f.path === ".continue/TIERKIT.md");
    expect(readme).toBeDefined();
    expect(readme!.contents).toContain("No `tierkit.config.json` found");
  });

  it("TIERKIT.md does not warn when config was supplied", async () => {
    const adapter = new ContinueAdapter();
    const result = await adapter.export({
      plugins: [fullPlugin()],
      outDir: "/ignored",
      config: makeConfig(),
    });
    const readme = result.files.find((f) => f.path === ".continue/TIERKIT.md");
    expect(readme!.contents).not.toContain("No `tierkit.config.json` found");
  });
});
