import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeLlmCall } from "../src/runtime/proxy/llmCall.js";
import { MockModelClient } from "../src/model/providers/mock.js";

/**
 * These tests exercise the plugin-rules injection path end-to-end: a workspace with one
 * active plugin whose rule files declare specific text. We swap the provider client for a
 * MockModelClient and inspect the request the daemon would have forwarded — proving Tierkit
 * actually places plugin rules before user messages.
 */
describe("plugin rule injection into /v1/llm-call", () => {
  let root: string;
  let chatSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-rules-inject-"));
    // Spy on every MockModelClient instance's chat method — the daemon constructs a new
    // one per request via `pickProviderClient`, but spying on the prototype catches them all.
    chatSpy = vi.spyOn(MockModelClient.prototype, "chat");

    // Build a workspace with one active plugin that contributes a rule file.
    const pluginDir = path.join(root, ".tierkit", "plugins", "test-rules");
    await fs.mkdir(path.join(pluginDir, "rules"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "tierkit.plugin.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "test-rules",
        name: "Test Rules",
        version: "0.1.0",
        description: "Test plugin with rules",
        author: "test",
        license: "MIT",
        compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
        components: {
          commands: [],
          modes: [],
          rules: ["rules/use-tools.md"],
        },
        permissions: {
          readFiles: true, editFiles: false, runCommands: false, registerMcp: false,
          useLocalDeviceModel: true, usePrivateRemoteModel: false, usePublicCloudModel: false,
          accessSecrets: false,
        },
        modelPolicy: { defaultTier: "mockProfile", preferPrivateRemoteBeforePublicCloud: true, publicCloudRequiresApproval: true, publicCloudDefaultMode: "review-only" },
        freedom: { level: "free" },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "rules", "use-tools.md"),
      "TIERKIT-RULE-MARKER-12345: Always use the read_file tool before answering questions about code.",
    );

    // Register it in the plugin registry as installed. RegistryEntrySchema is strict —
    // only id/version/installedAt/pluginDir/manifest are allowed at the top level.
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".tierkit", "plugins.json"),
      JSON.stringify({
        version: "0.1",
        plugins: [
          {
            id: "test-rules",
            version: "0.1.0",
            installedAt: new Date().toISOString(),
            pluginDir,
            manifest: {
              schemaVersion: "0.1",
              id: "test-rules",
              name: "Test Rules",
              version: "0.1.0",
              description: "Test plugin with rules",
              author: "test",
              license: "MIT",
              compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
              components: { commands: [], modes: [], rules: ["rules/use-tools.md"], workflows: [], hooks: [] },
              permissions: {
                readFiles: true, editFiles: false, runCommands: false, registerMcp: false,
                useLocalDeviceModel: true, usePrivateRemoteModel: false, usePublicCloudModel: false,
                accessSecrets: false,
              },
              modelPolicy: { defaultTier: "mockProfile", preferPrivateRemoteBeforePublicCloud: true, publicCloudRequiresApproval: true, publicCloudDefaultMode: "review-only" },
              freedom: { level: "free" },
            },
          },
        ],
      }),
    );

    // Workspace config — activate the plugin, define a mock profile.
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        activePlugins: ["test-rules"],
        modelProfiles: {
          mockProfile: { kind: "local-device", provider: "mock", model: "mock-1" },
        },
      }),
    );

  });

  afterEach(() => {
    chatSpy.mockRestore();
  });

  function lastSeenRequest(): { messages: { role: string; content: string }[] } {
    const call = chatSpy.mock.calls[chatSpy.mock.calls.length - 1];
    if (!call) throw new Error("MockModelClient.chat was never called");
    return call[1] as { messages: { role: string; content: string }[] };
  }

  it("prepends plugin rules as a system message before user messages", async () => {
    const r = await executeLlmCall(
      {
        profileId: "mockProfile",
        messages: [{ role: "user", content: "what's in my code?" }],
      },
      { cwd: root, env: {} },
    );
    expect(r.ok).toBe(true);
    const req = lastSeenRequest();
    // First message: Tierkit-injected plugin rules (system)
    expect(req.messages[0]!.role).toBe("system");
    expect(req.messages[0]!.content).toContain("TIERKIT-RULE-MARKER-12345");
    expect(req.messages[0]!.content).toContain("read_file tool");
    // Second message: user's original
    expect(req.messages[1]!.role).toBe("user");
    expect(req.messages[1]!.content).toBe("what's in my code?");
  });

  it("preserves caller-supplied system messages after the Tierkit rules", async () => {
    await executeLlmCall(
      {
        profileId: "mockProfile",
        messages: [
          { role: "system", content: "Caller-specific system prompt" },
          { role: "user", content: "hi" },
        ],
      },
      { cwd: root, env: {} },
    );
    const req = lastSeenRequest();
    expect(req.messages[0]!.role).toBe("system");
    expect(req.messages[0]!.content).toContain("TIERKIT-RULE-MARKER-12345");
    expect(req.messages[1]!.role).toBe("system");
    expect(req.messages[1]!.content).toBe("Caller-specific system prompt");
    expect(req.messages[2]!.role).toBe("user");
  });

  it("does NOT inject when runtime.injectPluginRules is false", async () => {
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        activePlugins: ["test-rules"],
        modelProfiles: {
          mockProfile: { kind: "local-device", provider: "mock", model: "mock-1" },
        },
        runtime: { injectPluginRules: false, port: 4101, dataDir: ".tierkit/runtime", host: "127.0.0.1" },
      }),
    );
    await executeLlmCall(
      {
        profileId: "mockProfile",
        messages: [{ role: "user", content: "hi" }],
      },
      { cwd: root, env: {} },
    );
    const req = lastSeenRequest();
    expect(req.messages[0]!.role).toBe("user");
    // No marker in any message
    expect(req.messages.every((m) => !m.content.includes("TIERKIT-RULE-MARKER-12345"))).toBe(true);
  });

  it("no-op when no plugins are active", async () => {
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        activePlugins: [],
        modelProfiles: {
          mockProfile: { kind: "local-device", provider: "mock", model: "mock-1" },
        },
      }),
    );
    await executeLlmCall(
      {
        profileId: "mockProfile",
        messages: [{ role: "user", content: "hi" }],
      },
      { cwd: root, env: {} },
    );
    const req = lastSeenRequest();
    // Should be only the user message — no injected system message.
    expect(req.messages.length).toBe(1);
    expect(req.messages[0]!.role).toBe("user");
  });
});
