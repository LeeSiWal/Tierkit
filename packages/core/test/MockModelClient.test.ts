import { describe, it, expect } from "vitest";
import { MockModelClient } from "../src/model/providers/mock.js";
import type { ModelProfile } from "../src/model/ModelProfile.js";

const localProfile: ModelProfile = {
  kind: "local-device",
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  model: "x",
  roles: [],
};

describe("MockModelClient", () => {
  it("returns canned chat text + tracks the call", async () => {
    const m = new MockModelClient({ text: "hello", inputTokens: 4, outputTokens: 2 });
    const r = await m.chat(localProfile, { messages: [{ role: "user", content: "hi" }] }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("hello");
      expect(r.usage.inputTokens).toBe(4);
      expect(r.usage.outputTokens).toBe(2);
    }
    expect(m.calls.map((c) => c.kind)).toEqual(["chat"]);
  });

  it("streams canned chunks as delta events bracketed by start/end", async () => {
    const m = new MockModelClient({
      chunks: ["hel", "lo"],
      inputTokens: 4,
      outputTokens: 5,
    });
    const events: string[] = [];
    for await (const evt of m.stream(localProfile, { messages: [] }, {})) {
      events.push(evt.type);
    }
    expect(events[0]).toBe("start");
    expect(events.filter((e) => e === "delta").length).toBe(2);
    expect(events).toContain("usage");
    expect(events[events.length - 1]).toBe("end");
  });

  it("emits an error event when failWith is configured", async () => {
    const m = new MockModelClient({ failWith: { code: "unauthorized", message: "nope", status: 401 } });
    const events: { type: string }[] = [];
    for await (const evt of m.stream(localProfile, { messages: [] }, {})) {
      events.push(evt);
    }
    expect(events.find((e) => e.type === "error")).toBeDefined();
    expect(events.find((e) => e.type === "end")).toBeUndefined();
  });

  it("probe reports modelAvailable=true by default and failWith.code on failure", async () => {
    const ok = await new MockModelClient({}).probe(localProfile);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.modelAvailable).toBe(true);

    const fail = await new MockModelClient({
      failWith: { code: "unreachable", message: "down" },
    }).probe(localProfile);
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.code).toBe("unreachable");
  });
});
