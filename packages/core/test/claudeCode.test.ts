import { describe, it, expect } from "vitest";
import { ClaudeCodeProvider } from "../src/model/providers/claudeCode.js";

const p = new ClaudeCodeProvider();

describe("ClaudeCodeProvider.parseStdout", () => {
  it("parses canonical claude --output-format=json shape", () => {
    const r = p.parseStdout(JSON.stringify({
      type: "result",
      result: "the answer is 42",
      usage: { input_tokens: 12, output_tokens: 4 },
    }));
    expect(r.content).toBe("the answer is 42");
    expect(r.inputTokens).toBe(12);
    expect(r.outputTokens).toBe(4);
  });

  it("accepts {content} shape", () => {
    const r = p.parseStdout(JSON.stringify({ content: "ok" }));
    expect(r.content).toBe("ok");
  });

  it("accepts {text} shape", () => {
    const r = p.parseStdout(JSON.stringify({ text: "ok" }));
    expect(r.content).toBe("ok");
  });

  it("accepts {message} shape", () => {
    const r = p.parseStdout(JSON.stringify({ message: "ok" }));
    expect(r.content).toBe("ok");
  });

  it("accepts camelCase usage keys", () => {
    const r = p.parseStdout(JSON.stringify({
      result: "x",
      usage: { inputTokens: 9, outputTokens: 1 },
    }));
    expect(r.inputTokens).toBe(9);
    expect(r.outputTokens).toBe(1);
  });

  it("falls back to raw stdout when JSON is unparseable", () => {
    const r = p.parseStdout("not json at all");
    expect(r.content).toBe("not json at all");
    expect(r.inputTokens).toBeUndefined();
    expect(r.outputTokens).toBeUndefined();
  });

  it("ignores non-numeric usage values", () => {
    const r = p.parseStdout(JSON.stringify({
      result: "x",
      usage: { input_tokens: "twelve", output_tokens: null },
    }));
    expect(r.inputTokens).toBeUndefined();
    expect(r.outputTokens).toBeUndefined();
  });

  it("ignores negative usage values", () => {
    const r = p.parseStdout(JSON.stringify({
      result: "x",
      usage: { input_tokens: -5, output_tokens: 2 },
    }));
    expect(r.inputTokens).toBeUndefined();
    expect(r.outputTokens).toBe(2);
  });
});

describe("ClaudeCodeProvider.buildArgs", () => {
  it("passes through transport.args verbatim", () => {
    const args = p.buildArgs({
      transport: { type: "subprocess", command: "claude", args: ["-p", "--output-format", "json"] },
    } as any);
    expect(args).toEqual(["-p", "--output-format", "json"]);
  });

  it("defaults to empty args when transport.args is missing", () => {
    const args = p.buildArgs({
      transport: { type: "subprocess", command: "claude" },
    } as any);
    expect(args).toEqual([]);
  });
});
