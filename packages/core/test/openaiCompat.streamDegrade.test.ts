/**
 * v0.14 stream-subprocess tests.
 *
 * Before v0.14: subprocess providers (claude-code) were always routed through
 * streamDegradedResponse(), which collected the full response and emitted it
 * with a `tierkit.warning: "stream-degraded-to-non-stream"` field.
 *
 * v0.14: ClaudeCodeProvider overrides parseStreamLine() so it now routes through
 * streamSubprocessResponse() — real per-token SSE with NO warning.
 * The degrade path is still available for future SubscriptionCliProvider subclasses
 * that do NOT override parseStreamLine().
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmpScripts: string;
beforeAll(async () => { tmpScripts = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-fakecli-")); });

async function fakeClaude(name: string, body: string): Promise<string> {
  const f = path.join(tmpScripts, `${name}.mjs`);
  await fs.writeFile(f, body, "utf8");
  return f;
}

async function readSse(body: ReadableStream<Uint8Array>): Promise<any[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const events: any[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = acc.indexOf("\n\n")) !== -1) {
      const block = acc.slice(0, idx);
      acc = acc.slice(idx + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return events;
      events.push(JSON.parse(data));
    }
  }
  return events;
}

describe("openaiCompat — subprocess native stream (v0.14)", () => {
  let root: string;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("emits SSE with NO tierkit.warning when ClaudeCodeProvider uses stream-json format", async () => {
    // Fake CLI emits stream-json lines (what claude --output-format=stream-json produces)
    const script = await fakeClaude("stream-native", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({type:"system", subtype:"init"}) + "\\n");
        process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"hello"}]}}) + "\\n");
        process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:" world"}]}}) + "\\n");
        process.stdout.write(JSON.stringify({type:"result", subtype:"success", result:"hello world",
          usage:{input_tokens:5, output_tokens:5}}) + "\\n");
      });
    `);

    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-native-stream-"));
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
            // streamArgs() will replace --output-format json with stream-json --verbose
            args: [script, "--output-format", "json"],
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
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await readSse(res.body!);
    expect(events.length).toBeGreaterThan(0);

    // NO warning should be present — this is native streaming
    for (const ev of events) {
      expect(ev.tierkit?.warning).not.toBe("stream-degraded-to-non-stream");
    }

    // Should have multiple delta events with text content
    const textChunks = events.map((e) => e.choices?.[0]?.delta?.content ?? "").filter(Boolean);
    expect(textChunks.length).toBeGreaterThanOrEqual(2);

    const fullText = events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(fullText).toContain("hello");
    expect(fullText).toContain("world");
  });

  it("emits SSE with NO warning even when script outputs non-streaming JSON (graceful degrade)", async () => {
    // Script outputs plain JSON (as with --output-format=json). parseStreamLine returns
    // undefined for all lines (they're not stream-json events). The stream() impl falls
    // back to emitting the full parsed content as a single delta — still NO warning.
    const script = await fakeClaude("non-stream-json", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({
          type:"result", result:"hello from fake claude",
          usage:{input_tokens:5, output_tokens:5}
        }));
      });
    `);

    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-nostream-cwd-"));
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
    const events = await readSse(res.body!);
    expect(events.length).toBeGreaterThan(0);

    // Still NO warning — ClaudeCodeProvider handles this via graceful fallback in stream()
    for (const ev of events) {
      expect(ev.tierkit?.warning).not.toBe("stream-degraded-to-non-stream");
    }

    const text = events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toContain("hello from fake claude");
  });
});
