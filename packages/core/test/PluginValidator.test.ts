import { describe, it, expect } from "vitest";
import { validatePluginManifest } from "../src/plugin/PluginValidator.js";
import type { PluginManifest } from "../src/plugin/PluginManifest.js";

const VALID: unknown = {
  schemaVersion: "0.1",
  id: "test-plugin",
  name: "Test Plugin",
  version: "0.1.0",
  description: "A test plugin",
  author: "tierkit",
  license: "MIT",
  compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
  components: {
    commands: [
      { name: "brainstorm", file: "commands/brainstorm.md", description: "Plan", category: "planning" },
    ],
  },
  permissions: { readFiles: true },
  freedom: { level: "free" },
};

describe("validatePluginManifest", () => {
  it("accepts a minimally valid manifest", () => {
    const result = validatePluginManifest(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const m: PluginManifest = result.manifest;
      expect(m.id).toBe("test-plugin");
      expect(m.permissions.readFiles).toBe(true);
      expect(m.permissions.runCommands).toBe(false);
    }
  });

  it("rejects an invalid plugin id", () => {
    const result = validatePluginManifest({ ...(VALID as object), id: "Invalid_ID" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === "id")).toBe(true);
    }
  });

  it("rejects an unknown schemaVersion", () => {
    const result = validatePluginManifest({ ...(VALID as object), schemaVersion: "9.9" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown target", () => {
    const v = structuredClone(VALID) as any;
    v.compatibility.targets = ["pizza"];
    const result = validatePluginManifest(v);
    expect(result.ok).toBe(false);
  });

  it("warns when free freedom level grants runCommands", () => {
    const v = structuredClone(VALID) as any;
    v.permissions.runCommands = true;
    const result = validatePluginManifest(v);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.some((w) => w.path === "permissions.runCommands"),
      ).toBe(true);
    }
  });

  it("warns when public-cloud requested without private-remote", () => {
    const v = structuredClone(VALID) as any;
    v.permissions.usePublicCloudModel = true;
    const result = validatePluginManifest(v);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.path === "permissions")).toBe(true);
    }
  });

  it("warns when plugin has no components", () => {
    const v = structuredClone(VALID) as any;
    v.components = {};
    const result = validatePluginManifest(v);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.path === "components")).toBe(true);
    }
  });

  it("treats warnings as errors in strict mode", () => {
    const v = structuredClone(VALID) as any;
    v.components = {};
    const result = validatePluginManifest(v, { strict: true });
    expect(result.ok).toBe(false);
  });
});
