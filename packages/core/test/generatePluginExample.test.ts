import { describe, it, expect } from "vitest";
import { GENERATE_PLUGIN_EXAMPLE, GENERATE_PLUGIN_EXAMPLE_JSON } from "../src/usecases/generatePluginExample.js";
import { PluginManifestSchema } from "../src/plugin/PluginManifest.js";

describe("generatePluginExample", () => {
  it("manifest passes PluginManifestSchema", () => {
    expect(() => PluginManifestSchema.parse(GENERATE_PLUGIN_EXAMPLE.manifest)).not.toThrow();
  });

  it("each rule has a valid filename", () => {
    const FILENAME_RE = /^[0-9a-z][0-9a-z._-]*\.md$/;
    for (const rule of GENERATE_PLUGIN_EXAMPLE.rules) {
      expect(rule.filename).toMatch(FILENAME_RE);
      expect(rule.content.length).toBeGreaterThan(20);
    }
  });

  it("manifest.components.rules matches the rule filenames (with rules/ prefix)", () => {
    const expected = GENERATE_PLUGIN_EXAMPLE.rules.map((r) => `rules/${r.filename}`).sort();
    expect([...GENERATE_PLUGIN_EXAMPLE.manifest.components.rules].sort()).toEqual(expected);
  });

  it("GENERATE_PLUGIN_EXAMPLE_JSON is a string serialization of the same data", () => {
    const parsed = JSON.parse(GENERATE_PLUGIN_EXAMPLE_JSON) as typeof GENERATE_PLUGIN_EXAMPLE;
    expect(parsed.manifest.id).toBe(GENERATE_PLUGIN_EXAMPLE.manifest.id);
    expect(parsed.rules.length).toBe(GENERATE_PLUGIN_EXAMPLE.rules.length);
  });
});
