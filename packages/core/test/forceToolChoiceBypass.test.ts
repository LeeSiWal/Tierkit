/**
 * When the caller passes `toolChoice: "required"` (or a specific function), the tool-shim
 * MUST be disabled so the structured `tools` array + `toolChoice` flow through to the
 * provider. Without this bypass, the shim would convert tools into XML in the system
 * prompt and strip them from the wire request — which means Ollama's `format` enforcement
 * (and OpenAI/Anthropic's native tool_choice) never apply, so the force-edit feature
 * silently degrades into "polite request to use tools" which weak models ignore.
 *
 * This test boots a real Tierkit Server with a mock provider that captures the chat
 * args, posts a /v1/openai/chat/completions request with toolChoice:"required", and
 * asserts that the provider received the structured tools + toolChoice (not stripped).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import * as providersIndex from "../src/model/providers/index.js";
import type { ChatRequest } from "../src/model/providers/chatTypes.js";

let tmp: string;
let server: RunningServer | undefined;
let originalHome: string | undefined;
let captured: ChatRequest | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-force-bypass-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.TIERKIT_NO_DISCOVERY;
  captured = undefined;
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        localFake: { kind: "local-device", provider: "mock", model: "tiny", roles: [] },
      },
      routingPolicy: { autoEscalationCeiling: "local-device" },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1", discoverOllamaModels: false, toolShim: "auto" },
    }),
  );
  // Mock provider client: capture the chat() request so we can inspect tools/toolChoice.
  vi.spyOn(providersIndex, "pickProviderClient").mockReturnValue({
    probe: async () => ({ ok: true, modelCount: 1, modelAvailable: true, latencyMs: 1 }),
    chat: async (_profile, req) => {
      captured = req;
      return {
        ok: true,
        text: "",
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        model: "tiny",
        toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"x","content":"y"}' } }],
        finishReason: "tool_calls",
      };
    },
    stream: async function* () { /* not used */ },
  } as unknown as ReturnType<typeof providersIndex.pickProviderClient>);
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { await server.close(); server = undefined; }
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("toolShim bypass when toolChoice is forced", () => {
  it("forwards tools + toolChoice to provider when toolChoice === 'required' (even for local-device)", async () => {
    const baseUrl = `http://${server!.address}:${server!.port}`;
    const r = await fetch(`${baseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "localFake",
        messages: [{ role: "user", content: "edit foo" }],
        tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
        tool_choice: "required",
      }),
    });
    expect(r.status).toBe(200);
    // Provider was called WITH structured tools + toolChoice (not stripped by the shim).
    expect(captured).toBeDefined();
    expect(captured!.tools).toBeDefined();
    expect(captured!.tools!.length).toBe(1);
    expect(captured!.toolChoice).toBe("required");
  });

  it("STILL applies the shim when toolChoice is absent (existing behavior preserved)", async () => {
    const baseUrl = `http://${server!.address}:${server!.port}`;
    await fetch(`${baseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "localFake",
        messages: [{ role: "user", content: "edit foo" }],
        tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
      }),
    });
    // No toolChoice → shim active → tools stripped from provider request.
    expect(captured).toBeDefined();
    expect(captured!.tools).toBeUndefined();
    expect(captured!.toolChoice).toBeUndefined();
    // Shim moves tools into the system prompt — check the first system message mentions them.
    const sysMsg = captured!.messages.find((m) => m.role === "system");
    expect(sysMsg).toBeDefined();
    expect(typeof sysMsg!.content === "string" ? sysMsg!.content : "").toMatch(/write_file/);
  });
});
