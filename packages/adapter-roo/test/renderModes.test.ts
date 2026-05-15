import { describe, it, expect } from "vitest";
import { renderModes, splitRoleAndInstructions } from "../src/renderModes.js";
import type { LoadedPlugin } from "@tierkit/core";

function makePlugin(opts: {
  id?: string;
  modes?: { id: string; name: string; file: string; tools: string[]; role: string; body: string }[];
  perms?: Partial<import("@tierkit/core").PermissionFlags>;
}): LoadedPlugin {
  const id = opts.id ?? "test-plugin";
  const modes = opts.modes ?? [];
  const files = new Map<string, string>();
  for (const m of modes) files.set(m.file, m.body);
  return {
    pluginDir: `/tmp/${id}`,
    files,
    manifest: {
      schemaVersion: "0.1",
      id,
      name: id,
      version: "0.1.0",
      description: "test",
      author: "tierkit",
      license: "MIT",
      compatibility: { tierkit: ">=0.1.0", targets: ["roo"] },
      components: {
        commands: [],
        modes: modes.map((m) => ({
          id: m.id,
          name: m.name,
          file: m.file,
          tools: m.tools,
          role: m.role,
        })),
        rules: [],
        workflows: [],
        hooks: [],
      },
      permissions: {
        readFiles: true,
        editFiles: false,
        runCommands: false,
        registerMcp: false,
        useLocalDeviceModel: true,
        usePrivateRemoteModel: false,
        usePublicCloudModel: false,
        accessSecrets: false,
        modifyAgentSettings: false,
        installDependencies: false,
        useNetwork: false,
        ...opts.perms,
      },
      freedom: { level: "free" },
    },
  };
}

describe("splitRoleAndInstructions", () => {
  it("uses first paragraph after H1 as roleDefinition", () => {
    const r = splitRoleAndInstructions(
      `# Free Coder\n\nA lightweight implementation persona for everyday coding work.\n\n## Stance\n\n- Run on local-device.\n`,
    );
    expect(r.roleDefinition).toBe("A lightweight implementation persona for everyday coding work.");
    expect(r.customInstructions).toContain("## Stance");
  });

  it("works without an H1 heading", () => {
    const r = splitRoleAndInstructions(`Just a paragraph.\n\nMore body.`);
    expect(r.roleDefinition).toBe("Just a paragraph.");
    expect(r.customInstructions).toBe("More body.");
  });

  it("returns no customInstructions when body has only one paragraph", () => {
    const r = splitRoleAndInstructions(`# Title\n\nOnly the intro paragraph.\n`);
    expect(r.roleDefinition).toBe("Only the intro paragraph.");
    expect(r.customInstructions).toBeUndefined();
  });
});

describe("renderModes", () => {
  it("namespaces slugs with the plugin id", () => {
    const plugin = makePlugin({
      id: "superpowers-free",
      perms: { editFiles: true },
      modes: [
        {
          id: "reviewer",
          name: "Reviewer",
          file: "modes/reviewer.md",
          tools: ["read", "search"],
          role: "reviewer",
          body: "# Reviewer\n\nReview diffs.\n\n## Stance\nBe specific.\n",
        },
      ],
    });
    const result = renderModes([plugin]);
    expect(result.file.customModes).toHaveLength(1);
    expect(result.file.customModes[0]?.slug).toBe("superpowers-free-reviewer");
    expect(result.file.customModes[0]?.name).toBe("Reviewer");
    expect(result.file.customModes[0]?.groups).toEqual(["read"]);
  });

  it("warns about modes pointing to missing files", () => {
    const plugin = makePlugin({
      id: "p",
      modes: [
        {
          id: "ghost",
          name: "Ghost",
          file: "modes/ghost.md",
          tools: ["read"],
          role: "?",
          body: "x",
        },
      ],
    });
    // Remove the file from the map to simulate a referenced-but-missing body
    plugin.files.delete("modes/ghost.md");
    const result = renderModes([plugin]);
    expect(result.file.customModes).toHaveLength(0);
    expect(result.warnings.some((w) => w.message.includes("modes/ghost.md"))).toBe(true);
  });

  it("warns about permission-filtered tool groups", () => {
    const plugin = makePlugin({
      id: "p",
      perms: { readFiles: true },
      modes: [
        {
          id: "powerful",
          name: "Powerful",
          file: "modes/powerful.md",
          tools: ["read", "terminal"],
          role: "?",
          body: "# Powerful\n\nDoes things.\n",
        },
      ],
    });
    const result = renderModes([plugin]);
    expect(result.file.customModes[0]?.groups).toEqual(["read"]);
    expect(
      result.warnings.some(
        (w) => w.message.includes("dropped Roo group") && w.message.includes("command"),
      ),
    ).toBe(true);
  });

  it("merges modes from multiple plugins, namespacing each", () => {
    const a = makePlugin({
      id: "a",
      modes: [
        { id: "x", name: "Ax", file: "m.md", tools: ["read"], role: "?", body: "Ax body." },
      ],
    });
    const b = makePlugin({
      id: "b",
      modes: [
        { id: "x", name: "Bx", file: "m.md", tools: ["read"], role: "?", body: "Bx body." },
      ],
    });
    const result = renderModes([a, b]);
    const slugs = result.file.customModes.map((m) => m.slug).sort();
    expect(slugs).toEqual(["a-x", "b-x"]);
  });
});
