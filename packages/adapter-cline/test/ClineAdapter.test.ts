import { describe, it, expect } from "vitest";
import { ClineAdapter } from "../src/ClineAdapter.js";
import { makePlugin } from "./fixtures.js";

function fullPlugin() {
  return makePlugin({
    id: "superpowers-free",
    name: "Superpowers Free",
    permissions: { readFiles: true, editFiles: true },
    commands: [
      {
        name: "brainstorm",
        description: "Explore",
        category: "planning",
        file: "commands/brainstorm.md",
        body: "Plan.",
      },
    ],
    modes: [
      {
        id: "reviewer",
        name: "Reviewer",
        tools: ["read", "search"],
        role: "reviewer",
        file: "modes/reviewer.md",
        body: "# Reviewer\n\nReview diffs.\n",
      },
    ],
    rules: [{ file: "rules/local-first.md", body: "Stay local-first." }],
    mcp: { file: "mcp/servers.json", body: '{"mcpServers": {}}' },
  });
}

describe("ClineAdapter", () => {
  it("emits a permission contract with 00- prefix (loads first)", async () => {
    const adapter = new ClineAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    const contract = result.files.find(
      (f) => f.path === ".clinerules/00-superpowers-free-permission.md",
    );
    expect(contract).toBeDefined();
    expect(contract!.contents).toContain("# Permission contract — Superpowers Free");
  });

  it("emits rules, modes, and commands at distinct prefixes", async () => {
    const adapter = new ClineAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toContain(".clinerules/10-superpowers-free-rule-local-first.md");
    expect(paths).toContain(".clinerules/20-superpowers-free-mode-reviewer.md");
    expect(paths).toContain(".clinerules/30-superpowers-free-command-brainstorm.md");
  });

  it("emits MCP under .cline/mcp/ and warns about non-auto-registration", async () => {
    const adapter = new ClineAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    expect(
      result.files.find((f) => f.path === ".cline/mcp/superpowers-free.json"),
    ).toBeDefined();
    expect(
      result.warnings.some((w) => w.message.includes("Cline will NOT auto-register")),
    ).toBe(true);
  });

  it("emits an extra warning when mcpServers is declared without registerMcp permission", async () => {
    const adapter = new ClineAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    expect(
      result.warnings.some((w) =>
        w.message.includes("does not request the `registerMcp` permission"),
      ),
    ).toBe(true);
  });

  it("emits both README files (one in .clinerules/, one in .cline/)", async () => {
    const adapter = new ClineAdapter();
    const result = await adapter.export({ plugins: [fullPlugin()], outDir: "/ignored" });
    const rulesReadme = result.files.find((f) => f.path === ".clinerules/TIERKIT.md");
    const mcpReadme = result.files.find((f) => f.path === ".cline/TIERKIT.md");
    expect(rulesReadme).toBeDefined();
    expect(mcpReadme).toBeDefined();
    expect(rulesReadme!.contents).toContain("Tierkit → Cline export");
    expect(mcpReadme!.contents).toContain("Tierkit → Cline MCP staging");
  });

  it("emits no .cline/mcp file when plugin has no mcpServers", async () => {
    const plugin = fullPlugin();
    delete (plugin.manifest.components as { mcpServers?: string }).mcpServers;
    plugin.files.delete("mcp/servers.json");
    const adapter = new ClineAdapter();
    const result = await adapter.export({ plugins: [plugin], outDir: "/ignored" });
    expect(result.files.find((f) => f.path.startsWith(".cline/mcp/"))).toBeUndefined();
  });
});
