import { describe, it, expect } from "vitest";
import { pickForwardHeaders } from "../src/runtime/anthropicGateway.js";

describe("pickForwardHeaders", () => {
  it("forwards Anthropic-required headers and drops hop-by-hop ones", () => {
    const out = pickForwardHeaders({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "x-api-key": "sk-test",
      "x-claude-code-session-id": "sess-1",
      "x-claude-code-agent-id": "agent-9",
      "host": "127.0.0.1:4101",
      "content-length": "42",
      "connection": "keep-alive",
      "transfer-encoding": "chunked",
    });
    expect(out["anthropic-version"]).toBe("2023-06-01");
    expect(out["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(out["x-api-key"]).toBe("sk-test");
    expect(out["x-claude-code-session-id"]).toBe("sess-1");
    expect(out["x-claude-code-agent-id"]).toBe("agent-9");
    expect(out["host"]).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
    expect(out["connection"]).toBeUndefined();
    expect(out["transfer-encoding"]).toBeUndefined();
  });

  it("forwards Authorization Bearer when x-api-key absent", () => {
    const out = pickForwardHeaders({
      "authorization": "Bearer some-oauth-token",
      "anthropic-version": "2023-06-01",
    });
    expect(out["authorization"]).toBe("Bearer some-oauth-token");
  });

  it("collapses array-valued headers to a comma-separated string", () => {
    const out = pickForwardHeaders({
      "anthropic-beta": ["prompt-caching-2024-07-31", "tools-2024-04-04"],
    });
    expect(out["anthropic-beta"]).toBe("prompt-caching-2024-07-31,tools-2024-04-04");
  });
});
