import { describe, it, expect } from "vitest";
import { RooAdapter } from "../src/RooAdapter.js";
import type { LoadedPlugin } from "@tierkit/core";

function samplePlugin(): LoadedPlugin {
  const files = new Map<string, string>([
    [
      "commands/brainstorm.md",
      "# /brainstorm\n\nExplore requirements and approaches.\n\n## Workflow\n\n1. Restate the task.\n",
    ],
    ["modes/reviewer.md", "# Reviewer\n\nReview diffs and changed files.\n\n## Stance\n\nBe specific.\n"],
    ["rules/local-first.md", "# Rule: local-first\n\nStay on local-device by default.\n"],
    ["mcp/servers.json", '{"mcpServers": {}}'],
  ]);
  return {
    pluginDir: "/tmp/test",
    files,
    manifest: {
      schemaVersion: "0.1",
      id: "superpowers-free",
      name: "Superpowers Free",
      version: "0.1.0",
      description: "test plugin",
      author: "tierkit",
      license: "MIT",
      compatibility: { tierkit: ">=0.1.0", targets: ["roo"] },
      components: {
        commands: [
          {
            name: "brainstorm",
            file: "commands/brainstorm.md",
            description: "Explore",
            category: "planning",
          },
        ],
        modes: [
          {
            id: "reviewer",
            name: "Reviewer",
            file: "modes/reviewer.md",
            tools: ["read", "search"],
            role: "reviewer",
          },
        ],
        rules: ["rules/local-first.md"],
        workflows: [],
        hooks: [],
        mcpServers: "mcp/servers.json",
      },
      permissions: {
        readFiles: true,
        editFiles: true,
        runCommands: false,
        registerMcp: false,
        useLocalDeviceModel: true,
        usePrivateRemoteModel: false,
        usePublicCloudModel: false,
        accessSecrets: false,
        modifyAgentSettings: false,
        installDependencies: false,
        useNetwork: false,
      },
      freedom: { level: "free" },
    },
  };
}

describe("RooAdapter", () => {
  it("emits .roomodes with namespaced slug", async () => {
    const adapter = new RooAdapter();
    const result = await adapter.export({ plugins: [samplePlugin()], outDir: "/ignored" });
    const modes = result.files.find((f) => f.path === ".roomodes");
    expect(modes).toBeDefined();
    const parsed = JSON.parse(modes!.contents);
    expect(parsed.customModes).toHaveLength(1);
    expect(parsed.customModes[0].slug).toBe("superpowers-free-reviewer");
    expect(parsed.customModes[0].groups).toContain("read");
  });

  it("emits namespaced command files under .roo/commands/", async () => {
    const adapter = new RooAdapter();
    const result = await adapter.export({ plugins: [samplePlugin()], outDir: "/ignored" });
    const cmd = result.files.find(
      (f) => f.path === ".roo/commands/superpowers-free-brainstorm.md",
    );
    expect(cmd).toBeDefined();
    expect(cmd!.contents).toMatch(/^---\nname: brainstorm/);
    expect(cmd!.contents).toContain("/brainstorm");
  });

  it("emits rules under .roo/rules/<pluginId>/", async () => {
    const adapter = new RooAdapter();
    const result = await adapter.export({ plugins: [samplePlugin()], outDir: "/ignored" });
    const rule = result.files.find(
      (f) => f.path === ".roo/rules/superpowers-free/local-first.md",
    );
    expect(rule).toBeDefined();
    expect(rule!.contents).toContain("Stay on local-device");
  });

  it("emits MCP config under .roo/mcp/ and emits an approval warning", async () => {
    const adapter = new RooAdapter();
    const result = await adapter.export({ plugins: [samplePlugin()], outDir: "/ignored" });
    const mcp = result.files.find((f) => f.path === ".roo/mcp/superpowers-free.json");
    expect(mcp).toBeDefined();
    expect(
      result.warnings.some((w) => w.message.includes("Roo will NOT auto-register")),
    ).toBe(true);
  });

  it("emits .roo/TIERKIT.md as the export README", async () => {
    const adapter = new RooAdapter();
    const result = await adapter.export({ plugins: [samplePlugin()], outDir: "/ignored" });
    const readme = result.files.find((f) => f.path === ".roo/TIERKIT.md");
    expect(readme).toBeDefined();
    expect(readme!.contents).toContain("# Tierkit → Roo / Zoo Code export");
    expect(readme!.contents).toContain("superpowers-free");
  });

  it("emits no .roomodes when no plugins define modes", async () => {
    const plugin = samplePlugin();
    plugin.manifest.components.modes = [];
    const adapter = new RooAdapter();
    const result = await adapter.export({ plugins: [plugin], outDir: "/ignored" });
    expect(result.files.find((f) => f.path === ".roomodes")).toBeUndefined();
  });
});
