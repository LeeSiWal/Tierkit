import type { PluginManifest } from "../plugin/PluginManifest.js";

export interface GeneratedPluginShape {
  manifest: PluginManifest;
  rules: Array<{ filename: string; content: string }>;
}

export const GENERATE_PLUGIN_EXAMPLE: GeneratedPluginShape = {
  manifest: {
    schemaVersion: "0.1",
    id: "tdd-first-python",
    name: "TDD-first Python",
    version: "0.1.0",
    description: "Always require a failing pytest test before any implementation; prefer small commits.",
    author: "Tierkit auto-generator",
    license: "MIT",
    compatibility: { tierkit: "^0.3.0", targets: ["generic"] },
    components: {
      commands: [],
      modes: [],
      rules: ["rules/01-failing-test-first.md", "rules/02-prefer-pytest.md", "rules/03-small-commits.md"],
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
    },
    freedom: { level: "balanced" },
  },
  rules: [
    {
      filename: "01-failing-test-first.md",
      content:
        "# Failing test first\n\n" +
        "Always write a failing pytest test BEFORE writing any implementation code. " +
        "The test must run and fail with an assertion error (not an import error) before the implementation begins. " +
        "Never modify both the test and the implementation in the same step.",
    },
    {
      filename: "02-prefer-pytest.md",
      content:
        "# Prefer pytest\n\n" +
        "When adding tests, use pytest idioms (`def test_x():`, fixtures, parametrize). " +
        "Never introduce unittest.TestCase classes unless the existing codebase already uses them.",
    },
    {
      filename: "03-small-commits.md",
      content:
        "# Small commits\n\n" +
        "Commit after each green test. " +
        "A commit must contain either (a) one failing test, or (b) the minimal implementation that makes the previously-failing test pass. " +
        "Never bundle test + implementation in the same commit.",
    },
  ],
};

export const GENERATE_PLUGIN_EXAMPLE_JSON = JSON.stringify(GENERATE_PLUGIN_EXAMPLE, null, 2);
