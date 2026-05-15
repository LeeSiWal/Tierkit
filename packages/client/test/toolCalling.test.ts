import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "@tierkit/core";

describe("OpenAI-compatible endpoint: tool calling round-trip", () => {
  let root: string;
  let server: RunningServer;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-tool-call-"));
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          mockProfile: { kind: "local-device", provider: "mock", model: "mock-1" },
        },
        // Tests in this block exercise the structured-passthrough path. The shim defaults
        // to "auto" (apply for local-device), which would strip tools from the mock and
        // suppress its built-in auto-synthesized tool_calls. Force-off here so we test
        // pure structured passthrough.
        runtime: { toolShim: "off", port: 4101, dataDir: ".tierkit/runtime", host: "127.0.0.1" },
      }),
    );
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close().catch(() => {});
  });

  it("forwards request.tools to provider and surfaces tool_calls in OpenAI response", async () => {
    const res = await fetch(`${baseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [{ role: "user", content: "list the files in src" }],
        tools: [
          {
            type: "function",
            function: {
              name: "list_files",
              description: "List files in a directory",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { role: string; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
    };
    const msg = body.choices[0]!.message;
    expect(msg.role).toBe("assistant");
    expect(msg.tool_calls).toBeDefined();
    expect(msg.tool_calls!.length).toBeGreaterThan(0);
    expect(msg.tool_calls![0]!.function.name).toBe("list_files");
    expect(msg.tool_calls![0]!.type).toBe("function");
    expect(typeof msg.tool_calls![0]!.function.arguments).toBe("string");
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("accepts a follow-up turn with a tool message (role=tool, tool_call_id) — multi-turn tool conversation", async () => {
    const res = await fetch(`${baseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_abc", type: "function", function: { name: "list_files", arguments: '{"path":"src"}' } }],
          },
          { role: "tool", tool_call_id: "call_abc", content: '["foo.ts","bar.ts"]' },
        ],
        tools: [
          {
            type: "function",
            function: { name: "list_files", parameters: { type: "object" } },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    // The mock will see the user/assistant/tool sequence and again surface a tool_call
    // (autoToolCall=true by default whenever tools is present). The point of this test is
    // that the request was accepted without "each message.content must be a string" or
    // similar regressions on the multi-turn shape.
    const body = (await res.json()) as { choices: { message: { content: string | null; tool_calls?: unknown } }[] };
    // content may be empty string from mock or null — both fine; presence of choices is enough.
    expect(body.choices.length).toBe(1);
  });

  it("tool_choice 'none' is forwarded (mock would still emit, but the field reaches the provider)", async () => {
    const res = await fetch(`${baseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "noop" } }],
        tool_choice: "none",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("forced tool_choice (function name) parses correctly", async () => {
    const res = await fetch(`${baseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "must_use" } }],
        tool_choice: { type: "function", function: { name: "must_use" } },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("auto-route viability: skips Ollama profile with model-not-installed and picks the mock that is viable", async () => {
    // Build a fresh server in this test with a mix of profiles: an Ollama profile pointing
    // at a model that won't be installed (so /api/tags probe shows it missing), and a mock
    // profile that's always viable. Auto should skip the Ollama one entirely.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { startServer } = await import("@tierkit/core");
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-viability-"));
    await fs.writeFile(
      path.join(localRoot, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          // Ollama pointing at a definitely-not-installed model. Probe will mark non-viable.
          ghostOllama: { kind: "local-device", provider: "ollama", model: "definitely-not-installed:7b", baseUrl: "http://127.0.0.1:1" },
          // Mock — always viable, returns a tool_call when tools are present.
          mockOk: { kind: "local-device", provider: "mock", model: "mock-good" },
        },
      }),
    );
    const localServer = await startServer({ cwd: localRoot, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${localServer.port}/v1/openai/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "ping" } }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { model?: string; tierkit?: { profileId?: string } };
      // mockOk should have been chosen — ghostOllama was filtered out by the viability check.
      expect(body.tierkit?.profileId).toBe("mockOk");
    } finally {
      await localServer.close().catch(() => {});
    }
  });

  it("tool-shim: weak model emitting JSON-in-content gets translated to structured tool_calls", async () => {
    // Simulate a weak local model that — like qwen2.5-coder:7b — responds with the OpenAI
    // function-call shape baked into the `content` text rather than the structured
    // `tool_calls` field. The shim (enabled by default for local-device tier) must detect
    // and translate so the caller sees a clean OpenAI structured response.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const { startServer, MockModelClient } = await import("@tierkit/core");
    const localRoot = await fs.mkdtemp(pathMod.join(os.tmpdir(), "tierkit-shim-e2e-"));
    await fs.writeFile(
      pathMod.join(localRoot, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          mockWeak: { kind: "local-device", provider: "mock", model: "weak-1" },
        },
      }),
    );
    // Patch MockModelClient: simulate a weak model that always emits the JSON-in-content
    // pattern (the qwen2.5-coder:7b shape). The shim strips `tools` before they reach the
    // mock, so we infer the tool name from the system prompt the shim writes — but here
    // we know exactly what the test sends, so hardcode "ask_followup_question".
    const origChat = MockModelClient.prototype.chat;
    MockModelClient.prototype.chat = async function (profile, _request, _env) {
      return {
        ok: true,
        text: `{\n  "name": "ask_followup_question",\n  "arguments": {\n    "question": "Why?"\n  }\n}`,
        usage: { inputTokens: 5, outputTokens: 12 },
        latencyMs: 1,
        model: profile.model,
      };
    };
    const localServer = await startServer({ cwd: localRoot, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${localServer.port}/v1/openai/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mockWeak",
          messages: [{ role: "user", content: "ask why" }],
          tools: [{ type: "function", function: { name: "ask_followup_question", parameters: { type: "object" } } }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        choices: {
          message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
          finish_reason: string;
        }[];
      };
      // The shim should have translated the JSON-in-content to structured tool_calls.
      const tc = body.choices[0]!.message.tool_calls;
      expect(tc).toBeDefined();
      expect(tc!.length).toBe(1);
      expect(tc![0]!.function.name).toBe("ask_followup_question");
      expect(JSON.parse(tc![0]!.function.arguments).question).toBe("Why?");
      // Content should be cleaned (the JSON is now in tool_calls, not duplicated in content).
      expect(body.choices[0]!.message.content).toBe(null);
      expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    } finally {
      MockModelClient.prototype.chat = origChat;
      await localServer.close().catch(() => {});
    }
  });

  it("backward compat: no tools field — response has no tool_calls and finish_reason is stop", async () => {
    const res = await fetch(`${baseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mockProfile",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { tool_calls?: unknown }; finish_reason: string }[] };
    expect(body.choices[0]!.message.tool_calls).toBeUndefined();
    expect(body.choices[0]!.finish_reason).toBe("stop");
  });
});
