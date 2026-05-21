import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

async function makeProject(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-pinned-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

describe("openaiCompat — pinned profile no silent fallback", () => {
  let root: string;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function start(config: object): Promise<number> {
    root = await makeProject(config);
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });
    return server.port;
  }

  async function post(port: number, body: object): Promise<{ status: number; json: any }> {
    const r = await fetch(`http://127.0.0.1:${port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  }

  it("returns 404 when pinned profile does not exist", async () => {
    const port = await start({ version: "0.1", modelProfiles: {} });
    const r = await post(port, { model: "nope", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(404);
    expect(r.json.error.profileId).toBe("nope");
  });

  it("returns 502 profile_not_viable when pinned subprocess profile has missing CLI", async () => {
    const port = await start({
      version: "0.1",
      modelProfiles: {
        claudeCode: {
          kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
          requiresApproval: true,
          transport: { type: "subprocess", command: "/nonexistent/binary-xyz", args: [], healthCheckArgs: ["--version"], timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrBytes: 1000 },
        },
      },
    });
    const r = await post(port, { model: "claudeCode", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(502);
    expect(r.json.error.type).toBe("profile_not_viable");
    expect(r.json.error.profileId).toBe("claudeCode");
    expect(r.json.error.reason).toBe("cli-not-found");
  });

  it("returns 502 profile_not_viable when pinned anthropic profile has missing API key", async () => {
    const port = await start({
      version: "0.1",
      modelProfiles: {
        claudeSonnet: {
          kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6",
          apiKeyEnv: "DEFINITELY_UNSET_API_KEY_XYZ123",
        },
      },
    });
    const r = await post(port, { model: "claudeSonnet", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(502);
    expect(r.json.error.type).toBe("profile_not_viable");
    expect(r.json.error.reason).toBe("missing-api-key");
  });

  it("returns 409 when pinned profile is in disabledProfileIds", async () => {
    const port = await start({
      version: "0.1",
      modelProfiles: {
        claudeCode: {
          kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
          requiresApproval: true,
          transport: { type: "subprocess", command: process.execPath, args: ["-e", "process.exit(0)"], healthCheckArgs: ["-e", "process.exit(0)"], timeoutMs: 5000, maxStdoutBytes: 1000, maxStderrBytes: 1000 },
        },
      },
      disabledProfileIds: ["claudeCode"],
    });
    const r = await post(port, { model: "claudeCode", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(409);
    expect(r.json.error.type).toBe("profile_disabled");
    expect(r.json.error.profileId).toBe("claudeCode");
  });
});
