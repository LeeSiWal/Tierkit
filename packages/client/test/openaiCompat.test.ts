import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer, MockModelClient } from "@tierkit/core";

describe("OpenAI-compatible inbound endpoint", () => {
  let root: string;
  let server: RunningServer;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-openaicompat-"));
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          mockProfile: { kind: "local-device", provider: "mock", model: "mock-1" },
        },
      }),
    );
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await server.close().catch(() => {});
  });

  it("POST /v1/openai/chat/completions returns OpenAI-shaped response for a valid profile", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: string;
      object: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]!.message.role).toBe("assistant");
    expect(typeof body.choices[0]!.message.content).toBe("string");
    expect(body.choices[0]!.finish_reason).toBe("stop");
    expect(typeof body.usage.total_tokens).toBe("number");
    expect(body.id).toMatch(/^chatcmpl-/);
  });

  it("returns OpenAI-shaped error envelope for missing fields", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mockProfile" }), // no messages
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { message?: string; type?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.message).toContain("messages");
  });

  it("returns invalid_request_error when model id is unknown", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "noSuchProfile",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("unknown-profile");
  });

  it("/v1/chat/completions (no /openai prefix) also works — for tools that strip the prefix", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("stream:true sends SSE chunks ending with [DONE]", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  });

  // Quiet unused-import lint by referencing the import; the test relies on the daemon
  // dispatching to MockModelClient via the configured `mock` provider, but the daemon
  // resolves that internally without needing this reference.
  void MockModelClient;
});
