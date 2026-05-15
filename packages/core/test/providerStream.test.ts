import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OllamaClient } from "../src/model/providers/ollama.js";
import { OpenAICompatibleClient } from "../src/model/providers/openaiCompatible.js";
import type { ModelProfile } from "../src/model/ModelProfile.js";
import type { StreamEvent } from "../src/model/providers/chatTypes.js";

interface MockServer {
  url: string;
  close(): Promise<void>;
}

function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>): Promise<MockServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe("OllamaClient.stream() — NDJSON", () => {
  let mock: MockServer | undefined;
  afterEach(async () => {
    if (mock) await mock.close();
    mock = undefined;
  });

  it("emits start, multiple deltas, usage, end", async () => {
    mock = await startMock((req, res) => {
      expect(req.url).toBe("/api/chat");
      res.setHeader("content-type", "application/x-ndjson");
      res.write(JSON.stringify({ message: { content: "hel" }, done: false }) + "\n");
      res.write(JSON.stringify({ message: { content: "lo" }, done: false }) + "\n");
      res.write(JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 5 }) + "\n");
      res.end();
    });
    const profile: ModelProfile = {
      kind: "local-device",
      provider: "ollama",
      baseUrl: mock.url,
      model: "qwen",
      roles: [],
    };
    const events = await collect(new OllamaClient().stream(profile, { messages: [{ role: "user", content: "hi" }] }, {}));
    expect(events[0]?.type).toBe("start");
    const deltas = events.filter((e) => e.type === "delta") as Extract<StreamEvent, { type: "delta" }>[];
    expect(deltas.map((d) => d.text).join("")).toBe("hello");
    const usage = events.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }> | undefined;
    expect(usage?.inputTokens).toBe(4);
    expect(usage?.outputTokens).toBe(5);
    expect(events[events.length - 1]?.type).toBe("end");
  });

  it("emits error event on bad status", async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 503;
      res.end("Service Unavailable");
    });
    const profile: ModelProfile = {
      kind: "local-device",
      provider: "ollama",
      baseUrl: mock.url,
      model: "qwen",
      roles: [],
    };
    const events = await collect(new OllamaClient().stream(profile, { messages: [] }, {}));
    const errEvt = events.find((e) => e.type === "error");
    expect(errEvt).toBeDefined();
    if (errEvt && errEvt.type === "error") expect(errEvt.code).toBe("bad-status");
  });

  it("returns a friendly message when ollama is unreachable", async () => {
    const profile: ModelProfile = {
      kind: "local-device",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:1", // closed port
      model: "qwen",
      roles: [],
    };
    const result = await new OllamaClient().chat(profile, { messages: [{ role: "user", content: "x" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unreachable");
      expect(result.message.toLowerCase()).toContain("ollama serve");
    }
  });
});

describe("OpenAICompatibleClient.stream() — SSE", () => {
  let mock: MockServer | undefined;
  afterEach(async () => {
    if (mock) await mock.close();
    mock = undefined;
  });

  it("emits start, deltas from data: chunks, end on [DONE]", async () => {
    mock = await startMock((req, res) => {
      expect(req.url).toBe("/chat/completions");
      expect(req.headers["authorization"]).toBe("Bearer xkey");
      res.setHeader("content-type", "text/event-stream");
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: "hel" } }] }) + "\n\n");
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: "lo" } }] }) + "\n\n");
      res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const profile: ModelProfile = {
      kind: "private-remote",
      provider: "openai-compatible",
      baseUrl: mock.url,
      model: "m",
      apiKeyEnv: "K",
      roles: [],
    };
    const events = await collect(
      new OpenAICompatibleClient().stream(profile, { messages: [{ role: "user", content: "hi" }] }, { K: "xkey" }),
    );
    expect(events[0]?.type).toBe("start");
    const deltas = events.filter((e) => e.type === "delta") as Extract<StreamEvent, { type: "delta" }>[];
    expect(deltas.map((d) => d.text).join("")).toBe("hello");
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events[events.length - 1]?.type).toBe("end");
  });

  it("emits an error event when env var missing", async () => {
    const profile: ModelProfile = {
      kind: "private-remote",
      provider: "openai-compatible",
      baseUrl: "https://nope",
      model: "m",
      apiKeyEnv: "MISSING",
      roles: [],
    };
    const events = await collect(
      new OpenAICompatibleClient().stream(profile, { messages: [] }, {}),
    );
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err && err.type === "error") expect(err.code).toBe("missing-api-key");
  });
});
