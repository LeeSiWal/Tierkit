import { describe, it, expect, afterEach, beforeAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-stable-")); });

async function fakeClaude(name: string, body: string): Promise<string> {
  const f = path.join(tmp, `${name}.mjs`);
  await fs.writeFile(f, body, "utf8");
  return f;
}

describe("routing stable under stream:true", () => {
  let root: string;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("non-streaming response carries tierkit.profileId and usageSource", async () => {
    const script = await fakeClaude("nostream", `
      let b=""; process.stdin.on("data", d=>b+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ type:"result", result:"ok",
          usage:{input_tokens:5,output_tokens:5}}));
      });
    `);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-stable-cwd-"));
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(root, ".tierkit", "plugins.json"),
      JSON.stringify({ version: "0.1", plugins: [] }));
    await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify({
      version: "0.1",
      migrations: { defaultDisabledSeededProfileIds: ["claudeCode"] },
      modelProfiles: {
        claudeCode: {
          kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
          requiresApproval: true,
          transport: {
            type: "subprocess", command: process.execPath, args: [script],
            healthCheckArgs: ["-e", "process.exit(0)"],
            timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
          },
        },
      },
    }));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claudeCode",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tierkit?.profileId).toBe("claudeCode");
    expect(json.tierkit?.usageSource).toBe("provider-reported");
  });

  it("auto + stream:true selects the same profile as auto + stream:false", async () => {
    const script = await fakeClaude("auto", `
      let b=""; process.stdin.on("data", d=>b+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ type:"result", result:"ok",
          usage:{input_tokens:1,output_tokens:1}}));
      });
    `);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-stable-auto-"));
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(root, ".tierkit", "plugins.json"),
      JSON.stringify({ version: "0.1", plugins: [] }));
    await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify({
      version: "0.1",
      migrations: { defaultDisabledSeededProfileIds: ["claudeCode"] },
      modelProfiles: {
        // Within the same tier, claudeCode (flat-rate) should beat claudeSonnet (per-token).
        // claudeSonnet has no API key in this test env, so it'd be pruned anyway, but we
        // include it so the router has more than one candidate to choose from.
        claudeSonnet: {
          kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6",
          apiKeyEnv: "UNSET_FOR_TEST_XYZ", paymentModel: "per-token",
        },
        claudeCode: {
          kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
          requiresApproval: true,
          transport: {
            type: "subprocess", command: process.execPath, args: [script],
            healthCheckArgs: ["-e", "process.exit(0)"],
            timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
          },
        },
      },
      // bias the risk scorer toward private-remote: declare task type intent in the message.
    }));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });

    const ns = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: false,
        messages: [{ role: "user", content: "please review this code" }] }),
    });
    const nsJson = await ns.json();
    const nsProfile = nsJson.tierkit?.profileId;

    const sr = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: true,
        messages: [{ role: "user", content: "please review this code" }] }),
    });
    const reader = sr.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    let sProfile: string | undefined;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      const line = acc.split("\n").find((l) => l.startsWith("data: "));
      if (line && line.length > 6) {
        const data = line.slice(6);
        if (data !== "[DONE]") {
          try { sProfile = JSON.parse(data).tierkit?.profileId; } catch { /* */ }
        }
      }
      if (sProfile) { reader.cancel(); break; }
    }

    expect(nsProfile).toBe(sProfile);
  });
});
