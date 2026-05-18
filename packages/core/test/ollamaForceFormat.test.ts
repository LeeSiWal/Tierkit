/**
 * Verifies the Ollama provider translates `tool_choice: "required"` into a JSON-schema
 * `format` constraint (Ollama 0.5+ feature) and parses the resulting JSON envelope back
 * into OpenAI-shape toolCalls. This is the local-side equivalent of OpenAI's tool_choice
 * enforcement — without this, force-edit would only work on cloud providers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaClient } from "../src/model/providers/ollama.js";
const ollamaClient = new OllamaClient();
import type { ModelProfile } from "../src/model/ModelProfile.js";
import type { ChatRequest } from "../src/model/providers/chatTypes.js";

const profile: ModelProfile = {
  kind: "local-device",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen:test",
  roles: [],
  cost: { type: "free" },
};

const req: ChatRequest = {
  messages: [{ role: "user", content: "edit foo.ts" }],
  tools: [
    { type: "function", function: { name: "write_file", parameters: { type: "object" } } },
    { type: "function", function: { name: "apply_diff", parameters: { type: "object" } } },
  ],
  toolChoice: "required",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ollama provider + tool_choice: 'required'", () => {
  it("sets `format` JSON schema on the request when toolChoice is 'required'", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: '{"tool_name":"write_file","arguments":{"path":"x","content":"y"}}' },
          eval_count: 5,
          prompt_eval_count: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const r = await ollamaClient.chat(profile, req, {});

    // Check the request body that went to Ollama
    expect(fetchSpy).toHaveBeenCalled();
    const lastCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/api/chat"));
    expect(lastCall).toBeDefined();
    const body = JSON.parse(String((lastCall![1] as RequestInit).body)) as { format?: { type?: string; properties?: { tool_name?: { enum?: string[] } } } };
    expect(body.format?.type).toBe("object");
    expect(body.format?.properties?.tool_name?.enum).toEqual(["write_file", "apply_diff"]);

    // Response is parsed: text emptied, toolCalls populated.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe("");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]!.function.name).toBe("write_file");
    expect(JSON.parse(r.toolCalls![0]!.function.arguments)).toEqual({ path: "x", content: "y" });
  });

  it("does NOT set format when toolChoice is 'auto' or undefined", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ message: { content: "Hello" }, eval_count: 1, prompt_eval_count: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await ollamaClient.chat(profile, { messages: req.messages }, {});

    const lastCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/api/chat"));
    const body = JSON.parse(String((lastCall![1] as RequestInit).body)) as { format?: unknown };
    expect(body.format).toBeUndefined();
  });

  it("restricts the enum to a single tool when toolChoice targets a specific function", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: '{"tool_name":"apply_diff","arguments":{}}' },
          eval_count: 1, prompt_eval_count: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await ollamaClient.chat(
      profile,
      { ...req, toolChoice: { type: "function", function: { name: "apply_diff" } } },
      {},
    );

    const lastCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/api/chat"));
    const body = JSON.parse(String((lastCall![1] as RequestInit).body)) as { format?: { properties?: { tool_name?: { enum?: string[] } } } };
    expect(body.format?.properties?.tool_name?.enum).toEqual(["apply_diff"]);
  });

  it("falls back gracefully when the forced JSON is malformed (no toolCalls, raw text preserved)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: "this is not JSON" },
          eval_count: 1, prompt_eval_count: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const r = await ollamaClient.chat(profile, req, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No toolCalls because JSON didn't parse — text is preserved (not blanked) so the
    // caller has SOMETHING to surface as an error/diagnostic.
    expect(r.toolCalls).toBeUndefined();
    expect(r.text).toBe("this is not JSON");
  });
});
