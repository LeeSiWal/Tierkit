import { describe, it, expect } from "vitest";
import { parseAgentResponse } from "../src/parseResponse.js";

describe("parseAgentResponse — single XML tool call", () => {
  it("extracts one tool call and preserves surrounding narrative", () => {
    const text =
      "I'll check the main file.\n" +
      "<read_file>\n<path>src/main.ts</path>\n</read_file>\n" +
      "Then I'll see what's inside.";
    const r = parseAgentResponse(text, ["read_file"]);
    expect(r.toolCalls.length).toBe(1);
    expect(r.toolCalls[0]!.name).toBe("read_file");
    expect(r.toolCalls[0]!.args.path).toBe("src/main.ts");
    expect(r.narrativeText).toContain("I'll check the main file.");
    expect(r.narrativeText).toContain("Then I'll see what's inside.");
    expect(r.narrativeText).not.toContain("<read_file>");
  });

  it("ignores tags for unknown tool names", () => {
    const text = "<unknown_tool><x>1</x></unknown_tool>";
    const r = parseAgentResponse(text, ["read_file"]);
    expect(r.toolCalls.length).toBe(0);
    expect(r.narrativeText).toContain("<unknown_tool>");
  });
});

describe("parseAgentResponse — multiple + ordered tool calls", () => {
  it("extracts multiple calls and preserves invocation order", () => {
    const text =
      "<read_file><path>a.ts</path></read_file>\n" +
      "Wait, also:\n" +
      "<list_files><path>src</path></list_files>";
    const r = parseAgentResponse(text, ["read_file", "list_files"]);
    expect(r.toolCalls.length).toBe(2);
    expect(r.toolCalls[0]!.name).toBe("read_file");
    expect(r.toolCalls[1]!.name).toBe("list_files");
  });
});

describe("parseAgentResponse — typed XML params", () => {
  it("coerces boolean, number, array, object param values", () => {
    const text = `<run_op>
<flag>true</flag>
<count>42</count>
<items>["a","b"]</items>
<config>{"x":1}</config>
<note>plain string</note>
</run_op>`;
    const r = parseAgentResponse(text, ["run_op"]);
    expect(r.toolCalls.length).toBe(1);
    const args = r.toolCalls[0]!.args;
    expect(args.flag).toBe(true);
    expect(args.count).toBe(42);
    expect(args.items).toEqual(["a", "b"]);
    expect(args.config).toEqual({ x: 1 });
    expect(args.note).toBe("plain string");
  });
});

describe("parseAgentResponse — task_complete sentinel", () => {
  it("recognizes <task_complete> as a special marker, not a tool call", () => {
    const text = "Done.\n<task_complete>\n<summary>Refactored auth module.</summary>\n</task_complete>";
    const r = parseAgentResponse(text, ["read_file"]);
    expect(r.toolCalls.length).toBe(0);
    expect(r.taskComplete).toBeDefined();
    expect(r.taskComplete!.summary).toBe("Refactored auth module.");
  });

  it("accepts <task_complete> with inline body as summary", () => {
    const text = "<task_complete>everything is fine</task_complete>";
    const r = parseAgentResponse(text, []);
    expect(r.taskComplete?.summary).toBe("everything is fine");
  });
});

describe("parseAgentResponse — degenerate inputs", () => {
  it("returns empty for empty string", () => {
    const r = parseAgentResponse("", ["read_file"]);
    expect(r.toolCalls).toEqual([]);
    expect(r.taskComplete).toBeUndefined();
  });

  it("ignores unclosed tags (returns no tool call rather than crashing)", () => {
    const text = "<read_file><path>foo.ts</path>";
    const r = parseAgentResponse(text, ["read_file"]);
    expect(r.toolCalls).toEqual([]);
  });
});
