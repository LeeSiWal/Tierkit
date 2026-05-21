/**
 * v0.17 regression: streaming chat (subprocess providers like claudeCode) must
 * append a UsageRecord to usage.jsonl on stream completion. Pre-v0.17 the
 * streaming code path silently skipped logging, so claudeCode never appeared
 * in the GUI activity panel.
 *
 * Tests use the same fake-CLI pattern as openaiCompat.streamDegrade.test.ts to
 * exercise the real HTTP → streamSubprocessResponse path.
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import { readUsage } from "../src/runtime/usageLog.js";

let tmpScripts: string;
beforeAll(async () => {
  tmpScripts = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-fakecli-ul-"));
});

async function fakeClaude(name: string, body: string): Promise<string> {
  const f = path.join(tmpScripts, `${name}.mjs`);
  await fs.writeFile(f, body, "utf8");
  return f;
}

async function drainSse(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
}

async function makeWorkspaceWithClaudeCode(script: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-stream-ul-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }));
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify({
    version: "0.1",
    modelProfiles: {
      claudeCode: {
        kind: "private-remote", provider: "claude-code", model: "auto", paymentModel: "flat-rate",
        requiresApproval: true,
        transport: {
          type: "subprocess",
          command: process.execPath,
          args: [script, "--output-format", "json"],
          healthCheckArgs: ["-e", "process.exit(0)"],
          timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
        },
      },
    },
  }));
  return root;
}

describe("openaiCompat streaming → usage.jsonl", () => {
  let root: string | undefined;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("appends a UsageRecord with ok:true after a normal stream completes", async () => {
    const script = await fakeClaude("stream-ok", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({type:"system", subtype:"init"}) + "\\n");
        process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"hi"}]}}) + "\\n");
        process.stdout.write(JSON.stringify({type:"result", subtype:"success", result:"hi",
          usage:{input_tokens:7, output_tokens:3}}) + "\\n");
      });
    `);
    root = await makeWorkspaceWithClaudeCode(script);
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claudeCode",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    await drainSse(res.body!);

    const records = await readUsage(path.join(root, ".tierkit/runtime/usage.jsonl"));
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.ok).toBe(true);
    expect(r.profileId).toBe("claudeCode");
    expect(r.provider).toBe("claude-code");
    expect(r.tier).toBe("private-remote");
    expect(r.inputTokens).toBe(7);
    expect(r.outputTokens).toBe(3);
    expect(typeof r.latencyMs).toBe("number");
  });

  it("writes ok:false when provider emits an error event before completion", async () => {
    // Fake CLI exits non-zero, which triggers SubscriptionCliProvider.stream()
    // to emit a type:"error" event (code "cli-exit-nonzero") and end the iterator.
    const script = await fakeClaude("stream-fail", `
      process.stderr.write("simulated provider failure");
      process.exit(2);
    `);
    root = await makeWorkspaceWithClaudeCode(script);
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claudeCode",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await drainSse(res.body!);

    const records = await readUsage(path.join(root, ".tierkit/runtime/usage.jsonl"));
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.ok).toBe(false);
    expect(r.profileId).toBe("claudeCode");
    expect(r.failureCode).toBeTruthy();
  });
});
