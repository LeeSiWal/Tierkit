import { describe, it, expect, afterEach, beforeAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-modeltest-")); });

async function fakeClaude(name: string, body: string): Promise<string> {
  const f = path.join(tmp, name + ".mjs");
  await fs.writeFile(f, body, "utf8");
  return f;
}

describe("/v1/models/test — subprocess + smoke chat + ignoreDisabled", () => {
  let root: string;
  let server: RunningServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function startWith(profile: any, opts: { disabled?: boolean } = {}): Promise<void> {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-modeltest-cwd-"));
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(root, ".tierkit", "plugins.json"),
      JSON.stringify({ version: "0.1", plugins: [] }));
    await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify({
      version: "0.1",
      migrations: { defaultDisabledSeededProfileIds: ["claudeCode"] }, // suppress seed
      modelProfiles: { claudeCode: profile },
      ...(opts.disabled ? { disabledProfileIds: ["claudeCode"] } : {}),
    }));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });
  }

  async function post(body: object): Promise<{ status: number; json: any }> {
    const r = await fetch(`http://127.0.0.1:${server!.port}/v1/models/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  }

  it("runs probe + smoke chat against subprocess profile with ignoreDisabled:true", async () => {
    const script = await fakeClaude("ok", `
      let b=""; process.stdin.on("data", d=>b+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ type:"result", result:"OK",
          usage:{input_tokens:5, output_tokens:1}}));
      });
    `);
    await startWith({
      kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
      requiresApproval: true,
      transport: {
        type: "subprocess", command: process.execPath, args: [script],
        healthCheckArgs: ["-e", "process.exit(0)"],
        timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
      },
    }, { disabled: true });
    const r = await post({ profileId: "claudeCode", smoke: true, ignoreDisabled: true });
    expect(r.status).toBe(200);
    expect(r.json.probe.ok).toBe(true);
    expect(r.json.smoke.ok).toBe(true);
    expect(r.json.smoke.content).toBe("OK");
  });

  it("returns 409 when disabled profile is tested without ignoreDisabled", async () => {
    const script = await fakeClaude("ok2", `process.stdout.write("OK"); process.exit(0);`);
    await startWith({
      kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
      requiresApproval: true,
      transport: {
        type: "subprocess", command: process.execPath, args: [script],
        healthCheckArgs: ["-e", "process.exit(0)"],
        timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
      },
    }, { disabled: true });
    const r = await post({ profileId: "claudeCode", smoke: true, ignoreDisabled: false });
    expect(r.status).toBe(409);
    expect(r.json.error.type).toBe("profile_disabled");
  });

  it("records smoke chat in usage.jsonl with type:'model-test'", async () => {
    const script = await fakeClaude("ok3", `
      let b=""; process.stdin.on("data", d=>b+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ type:"result", result:"OK",
          usage:{input_tokens:5, output_tokens:1}}));
      });
    `);
    await startWith({
      kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
      requiresApproval: true,
      transport: {
        type: "subprocess", command: process.execPath, args: [script],
        healthCheckArgs: ["-e", "process.exit(0)"],
        timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
      },
    }, { disabled: true });
    await post({ profileId: "claudeCode", smoke: true, ignoreDisabled: true });
    const usagePath = path.join(root, ".tierkit", "usage.jsonl");
    const text = await fs.readFile(usagePath, "utf8");
    const lines = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.type === "model-test");
    expect(entry).toBeDefined();
    expect(entry.profileId).toBe("claudeCode");
  });
});
