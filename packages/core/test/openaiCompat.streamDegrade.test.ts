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

describe("openaiCompat — subprocess stream degrade", () => {
  let root: string;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("emits SSE with tierkit.warning when the selected profile is subprocess", async () => {
    const script = await fakeClaude("ok", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({
          type:"result", result:"hello from fake claude",
          usage:{input_tokens:5, output_tokens:5}
        }));
      });
    `);

    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-streamdeg-"));
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
            args: [script],
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

    const first = events[0];
    const last = events[events.length - 1];
    expect(first.tierkit?.warning).toBe("stream-degraded-to-non-stream");
    expect(first.tierkit?.profileId).toBe("claudeCode");
    expect(last.tierkit?.warning).toBe("stream-degraded-to-non-stream");

    const text = events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toContain("hello from fake claude");
  });
});
