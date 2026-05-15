import type { LoadedPlugin, PluginManifest, TierkitConfig } from "@tierkit/core";

interface MakePluginOpts {
  id?: string;
  name?: string;
  permissions?: Partial<PluginManifest["permissions"]>;
  commands?: { name: string; description: string; category?: string; file: string; body: string }[];
  modes?: { id: string; name: string; tools: string[]; role: string; file: string; body: string }[];
  rules?: { file: string; body: string }[];
  mcp?: { file: string; body: string } | null;
}

export function makePlugin(opts: MakePluginOpts = {}): LoadedPlugin {
  const id = opts.id ?? "test-plugin";
  const files = new Map<string, string>();
  for (const c of opts.commands ?? []) files.set(c.file, c.body);
  for (const m of opts.modes ?? []) files.set(m.file, m.body);
  for (const r of opts.rules ?? []) files.set(r.file, r.body);
  if (opts.mcp) files.set(opts.mcp.file, opts.mcp.body);

  const manifest: PluginManifest = {
    schemaVersion: "0.1",
    id,
    name: opts.name ?? id,
    version: "0.1.0",
    description: "test plugin",
    author: "tierkit",
    license: "MIT",
    compatibility: { tierkit: ">=0.1.0", targets: ["continue"] },
    components: {
      commands: (opts.commands ?? []).map((c) => ({
        name: c.name,
        file: c.file,
        description: c.description,
        category: (c.category as "planning") ?? "misc",
      })),
      modes: (opts.modes ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        file: m.file,
        tools: m.tools,
        role: m.role,
      })),
      rules: (opts.rules ?? []).map((r) => r.file),
      workflows: [],
      hooks: [],
      ...(opts.mcp ? { mcpServers: opts.mcp.file } : {}),
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
      ...opts.permissions,
    },
    freedom: { level: "free" },
  };

  return { pluginDir: `/tmp/${id}`, files, manifest };
}

export function makeConfig(): TierkitConfig {
  return {
    version: "0.1",
    activePlugins: [],
    defaultTarget: "continue",
    modelProfiles: {
      localFast: {
        kind: "local-device",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        model: "qwen2.5-coder:7b",
        roles: ["simple-coder"],
      },
      privateRemoteStrong: {
        kind: "private-remote",
        provider: "openai-compatible",
        baseUrl: "https://my-private-llm.example.com/v1",
        model: "qwen-coder-72b",
        apiKeyEnv: "TIERKIT_PRIVATE_LLM_KEY",
        roles: ["coder", "complex-coder"],
      },
      publicCloudPremium: {
        kind: "public-cloud",
        provider: "anthropic",
        model: "claude-sonnet",
        roles: ["architect", "critical-reviewer"],
        requiresApproval: true,
        defaultMode: "review-only",
      },
    },
    routingPolicy: {
      preferPrivateRemoteBeforePublicCloud: true,
      publicCloudRequiresApproval: true,
      publicCloudDefaultMode: "review-only",
      riskThresholds: {
        localFastMax: 25,
        localStrongMax: 50,
        privateRemoteMax: 75,
        publicCloudReviewMin: 76,
      },
    },
    security: {
      redactSecretsForRemote: true,
      blockSecretFiles: true,
      dangerousCommandsRequireApproval: true,
    },
  };
}
