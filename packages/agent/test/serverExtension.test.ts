import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer, MockModelClient } from "@tierkit/core";
import { createAgentRouteExtension } from "../src/serverExtension.js";

/**
 * End-to-end smoke test for `/v1/agent/run`. Boots a real Tierkit daemon with the agent
 * route extension registered, configures a mock model profile that emits a scripted
 * sequence, and verifies the SSE response carries the right events in order.
 */
describe("POST /v1/agent/run — SSE stream", () => {
  let root: string;
  let server: RunningServer;
  let origChat: typeof MockModelClient.prototype.chat;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-agent-server-"));
    // A real file so read_file has something to read.
    await fs.writeFile(path.join(root, "hello.txt"), "world\n");

    // Workspace config — single mock profile, all Tierkit-side overlays off so the test is hermetic.
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          mockProfile: { kind: "local-device", provider: "mock", model: "mock" },
        },
        runtime: {
          injectPluginRules: false,
          toolShim: "off",
          discoverOllamaModels: false,
          port: 4101,
          dataDir: ".tierkit/runtime",
          host: "127.0.0.1",
        },
      }),
    );

    // Scripted mock: first turn emits an XML read_file tool call, second emits task_complete.
    let turn = 0;
    origChat = MockModelClient.prototype.chat;
    MockModelClient.prototype.chat = async function (profile) {
      turn++;
      if (turn === 1) {
        return {
          ok: true,
          text: "Let me check.\n<read_file>\n<path>hello.txt</path>\n</read_file>",
          usage: { inputTokens: 10, outputTokens: 10 },
          latencyMs: 1,
          model: profile.model,
        };
      }
      return {
        ok: true,
        text: "<task_complete><summary>Done — read hello.txt, it contains 'world'.</summary></task_complete>",
        usage: { inputTokens: 12, outputTokens: 12 },
        latencyMs: 1,
        model: profile.model,
      };
    };

    server = await startServer({
      cwd: root,
      host: "127.0.0.1",
      port: 0,
      routeExtensions: [createAgentRouteExtension({ approve: async () => true })],
    });
  });

  afterEach(async () => {
    MockModelClient.prototype.chat = origChat;
    await server.close().catch(() => {});
  });

  /** Pull every SSE `data:` line out of a chunked response body. */
  async function readSseEvents(resBody: ReadableStream<Uint8Array> | null): Promise<unknown[]> {
    if (!resBody) return [];
    const reader = resBody.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: unknown[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n\n");
      buf = lines.pop() ?? "";
      for (const block of lines) {
        const line = block.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload === "[DONE]") return events;
        try {
          events.push(JSON.parse(payload));
        } catch {
          /* skip malformed */
        }
      }
    }
    return events;
  }

  it("streams stream_open → task_start → assistant_text → tool_call → tool_result → task_complete", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "read hello.txt", modelId: "mockProfile" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = (await readSseEvents(res.body)) as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("stream_open");
    expect(types).toContain("task_start");
    expect(types).toContain("assistant_text");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("task_complete");
    expect(types[types.length - 1]).toBe("task_complete");
  });

  it("rejects missing task with 400 + invalid_request_error", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "mockProfile" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: { type: "invalid_request_error" } });
  });
});
