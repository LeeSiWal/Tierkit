import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import { createSecretsStore } from "../src/security/SecretsStore.js";

let tmp: string;
let server: RunningServer | undefined;

async function bootServer(env: Record<string, string | undefined> = {}): Promise<{
  baseUrl: string;
  cwd: string;
}> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-secretsep-"));
  const cwd = tmp;
  const dataDir = path.join(cwd, ".tierkit");
  await fs.mkdir(dataDir, { recursive: true });
  // Minimal config so loadConfig doesn't throw inside any handler.
  await fs.writeFile(
    path.join(cwd, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      activePlugins: [],
      defaultTarget: "generic",
      modelProfiles: {
        claudeSonnet: {
          kind: "private-remote",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          roles: ["code"],
          cost: { type: "free" },
        },
      },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
  const secrets = createSecretsStore({ dataDir, env });
  await secrets.loadIntoEnv();
  server = await startServer({ cwd, host: "127.0.0.1", port: 0, secrets, env });
  return { baseUrl: `http://${server.address}:${server.port}`, cwd };
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("GET /v1/secrets", () => {
  it("lists keys referenced by profiles as unset when none stored", async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/v1/secrets`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: Array<{ key: string; set: boolean; masked: string }> };
    const ant = body.entries.find((e) => e.key === "ANTHROPIC_API_KEY");
    expect(ant).toEqual({ key: "ANTHROPIC_API_KEY", set: false, masked: "" });
  });

  it("never returns the plaintext value, only masked", async () => {
    const { baseUrl } = await bootServer({ ANTHROPIC_API_KEY: "sk-ant-supersecretvalue123" });
    const r = await fetch(`${baseUrl}/v1/secrets`);
    const text = await r.text();
    expect(text).not.toContain("supersecretvalue");
  });
});

describe("POST /v1/secrets", () => {
  it("stores a key and reports it as set on the next GET", async () => {
    const { baseUrl } = await bootServer();
    const post = await fetch(`${baseUrl}/v1/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-ant-newvalue1234567" }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { ok: boolean; masked: string };
    expect(postBody.ok).toBe(true);
    expect(postBody.masked).toBe("sk-ant-…4567");

    const get = await fetch(`${baseUrl}/v1/secrets`);
    const body = (await get.json()) as { entries: Array<{ key: string; set: boolean; masked: string }> };
    const ant = body.entries.find((e) => e.key === "ANTHROPIC_API_KEY");
    expect(ant?.set).toBe(true);
    expect(ant?.masked).toBe("sk-ant-…4567");
  });

  it("rejects invalid env var names with 400", async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/v1/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "bad-name", value: "x" }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects empty values with 400", async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/v1/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "OPENAI_API_KEY", value: "" }),
    });
    expect(r.status).toBe(400);
  });
});
