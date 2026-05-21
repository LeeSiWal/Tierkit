import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmp = "";
let server: RunningServer | undefined;

async function bootServer(
  env: Record<string, string | undefined> = {},
): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-env-ep-"));
  await fs.mkdir(path.join(tmp, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  // claude-code provider requires subprocess transport. anthropic does not.
  // SubprocessTransportSchema is strict — only command/args/healthCheckArgs/timeoutMs/maxStdout/maxStderr.
  const cfg = {
    version: "0.1",
    activePlugins: [],
    defaultTarget: "generic",
    modelProfiles: {
      claudeCode: {
        kind: "private-remote",
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        roles: ["code"],
        transport: {
          type: "subprocess",
          command: "claude",
          args: ["api", "messages"],
          healthCheckArgs: ["--version"],
          timeoutMs: 3000,
        },
      },
      localModel: {
        kind: "local-device",
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        baseUrl: "http://127.0.0.1:11434",
        roles: ["code"],
      },
      anthropicModel: {
        kind: "private-remote",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        roles: ["code"],
      },
    },
    runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
  };
  await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify(cfg));
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0, env });
  return `http://${server.address}:${server.port}`;
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("GET /v1/environment", () => {
  beforeEach(() => {
    process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
  });
  afterEach(() => {
    delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
  });

  it("returns the expected shape: ollama, claudeCli, envVars", async () => {
    const baseUrl = await bootServer();
    const r = await fetch(`${baseUrl}/v1/environment`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ollama: { running: boolean; baseUrl: string };
      claudeCli: { onPath: boolean };
      envVars: Record<string, { present: boolean; source: string }>;
      taskTypes: string[];
    };
    expect(body).toHaveProperty("ollama");
    expect(body).toHaveProperty("claudeCli");
    expect(body).toHaveProperty("envVars");
    expect(typeof body.ollama.running).toBe("boolean");
    expect(typeof body.claudeCli.onPath).toBe("boolean");
    expect(typeof body.envVars).toBe("object");
  });

  it("includes apiKeyEnv keys from profiles in envVars", async () => {
    const baseUrl = await bootServer();
    const r = await fetch(`${baseUrl}/v1/environment`);
    const body = (await r.json()) as {
      envVars: Record<string, { present: boolean; source: string }>;
    };
    // ANTHROPIC_API_KEY comes from multiple profiles' apiKeyEnv
    expect(body.envVars).toHaveProperty("ANTHROPIC_API_KEY");
    // Default keys should always appear
    expect(body.envVars).toHaveProperty("OPENAI_API_KEY");
    expect(body.envVars).toHaveProperty("GEMINI_API_KEY");
  });

  it("reports process env keys as source=process when present in env", async () => {
    const baseUrl = await bootServer({ ANTHROPIC_API_KEY: "sk-ant-test123456789" });
    const r = await fetch(`${baseUrl}/v1/environment`);
    const body = (await r.json()) as {
      envVars: Record<string, { present: boolean; source: string }>;
    };
    expect(body.envVars["ANTHROPIC_API_KEY"].present).toBe(true);
    expect(body.envVars["ANTHROPIC_API_KEY"].source).toBe("process");
  });

  it("reports keys as source=none when not set in env", async () => {
    const baseUrl = await bootServer({});
    const r = await fetch(`${baseUrl}/v1/environment`);
    const body = (await r.json()) as {
      envVars: Record<string, { present: boolean; source: string }>;
    };
    expect(body.envVars["ANTHROPIC_API_KEY"].present).toBe(false);
    expect(body.envVars["ANTHROPIC_API_KEY"].source).toBe("none");
  });

  it("includes taskTypes array in response", async () => {
    const baseUrl = await bootServer();
    const r = await fetch(`${baseUrl}/v1/environment`);
    const body = (await r.json()) as { taskTypes: string[] };
    expect(Array.isArray(body.taskTypes)).toBe(true);
    expect(body.taskTypes.length).toBeGreaterThan(0);
    expect(body.taskTypes).toContain("code-review");
    expect(body.taskTypes).toContain("general");
  });

  it("ollama.baseUrl defaults to 127.0.0.1:11434 when profile uses that", async () => {
    const baseUrl = await bootServer();
    const r = await fetch(`${baseUrl}/v1/environment`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ollama: { baseUrl: string } };
    expect(body.ollama.baseUrl).toBe("http://127.0.0.1:11434");
  });
});
