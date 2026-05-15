import { describe, it, expect } from "vitest";
import { buildXmlToolInstructions, extractToolCallsFromText } from "../src/model/toolShim.js";

describe("buildXmlToolInstructions", () => {
  it("emits format header, tool sections, examples", () => {
    const text = buildXmlToolInstructions([
      {
        type: "function",
        function: {
          name: "list_files",
          description: "List files in a directory",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Directory path" } },
            required: ["path"],
          },
        },
      },
    ]);
    expect(text).toContain("# Available Tools");
    expect(text).toContain("## list_files");
    expect(text).toContain("List files in a directory");
    expect(text).toContain("path (string, required): Directory path");
    expect(text).toContain("<list_files>");
    expect(text).toContain("<path>...</path>");
  });
});

describe("extractToolCallsFromText — XML tags", () => {
  it("extracts a single XML tool call", () => {
    const text =
      "Let me look at the file.\n" +
      "<read_file>\n<path>src/main.ts</path>\n</read_file>\n" +
      "Then I'll review it.";
    const r = extractToolCallsFromText(text, ["read_file"]);
    expect(r.toolCalls.length).toBe(1);
    expect(r.toolCalls[0]!.function.name).toBe("read_file");
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ path: "src/main.ts" });
    // XML block removed from content; narrative preserved.
    expect(r.cleanedContent).not.toContain("<read_file>");
    expect(r.cleanedContent).toContain("Let me look at the file.");
    expect(r.cleanedContent).toContain("Then I'll review it.");
  });

  it("extracts multiple XML tool calls in one response", () => {
    const text =
      "<read_file><path>a.ts</path></read_file>\n" +
      "<read_file><path>b.ts</path></read_file>";
    const r = extractToolCallsFromText(text, ["read_file"]);
    expect(r.toolCalls.length).toBe(2);
    expect(JSON.parse(r.toolCalls[0]!.function.arguments).path).toBe("a.ts");
    expect(JSON.parse(r.toolCalls[1]!.function.arguments).path).toBe("b.ts");
  });

  it("treats JSON-shaped XML param values as parsed JSON", () => {
    const text = `<run_command><cmd>npm test</cmd><args>["--coverage", "--watch"]</args></run_command>`;
    const r = extractToolCallsFromText(text, ["run_command"]);
    const args = JSON.parse(r.toolCalls[0]!.function.arguments);
    expect(args.cmd).toBe("npm test");
    expect(args.args).toEqual(["--coverage", "--watch"]);
  });

  it("ignores XML tags for unknown tool names", () => {
    const text = "<unknown_tool><x>1</x></unknown_tool>";
    const r = extractToolCallsFromText(text, ["read_file"]);
    expect(r.toolCalls.length).toBe(0);
    expect(r.cleanedContent).toBe(text);
  });
});

describe("extractToolCallsFromText — JSON-in-content (the qwen2.5-coder pattern)", () => {
  it("extracts a bare-JSON tool call when content is purely the JSON object", () => {
    const text = `{
  "name": "ask_followup_question",
  "arguments": {
    "question": "What is the main goal?"
  }
}`;
    const r = extractToolCallsFromText(text, ["ask_followup_question"]);
    expect(r.toolCalls.length).toBe(1);
    expect(r.toolCalls[0]!.function.name).toBe("ask_followup_question");
    const args = JSON.parse(r.toolCalls[0]!.function.arguments);
    expect(args.question).toBe("What is the main goal?");
    // When the entire content was the call, cleanedContent is empty.
    expect(r.cleanedContent).toBe("");
  });

  it("extracts a code-fenced JSON tool call from mixed content", () => {
    const text = "I'll ask a clarifying question.\n```json\n{\"name\": \"ask_followup_question\", \"arguments\": {\"question\": \"hi\"}}\n```\nWaiting on the user.";
    const r = extractToolCallsFromText(text, ["ask_followup_question"]);
    expect(r.toolCalls.length).toBe(1);
    expect(JSON.parse(r.toolCalls[0]!.function.arguments).question).toBe("hi");
    expect(r.cleanedContent).toContain("I'll ask a clarifying question.");
    expect(r.cleanedContent).not.toContain("```");
  });

  it("handles arguments emitted as a JSON string (not object)", () => {
    const text = `{"name": "list_files", "arguments": "{\\"path\\": \\"src\\"}"}`;
    const r = extractToolCallsFromText(text, ["list_files"]);
    expect(r.toolCalls.length).toBe(1);
    // arguments should be the JSON-string-as-string preserved
    expect(r.toolCalls[0]!.function.arguments).toBe(`{"path": "src"}`);
  });

  it("ignores JSON with name that isn't a known tool", () => {
    const text = `{"name": "delete_everything", "arguments": {}}`;
    const r = extractToolCallsFromText(text, ["list_files"]);
    expect(r.toolCalls.length).toBe(0);
  });

  it("ignores malformed JSON", () => {
    const text = `{this is not valid json}`;
    const r = extractToolCallsFromText(text, ["list_files"]);
    expect(r.toolCalls.length).toBe(0);
    expect(r.cleanedContent).toBe(text);
  });
});

describe("extractToolCallsFromText — pure narrative (no tool use)", () => {
  it("returns empty when content is plain text", () => {
    const text = "I'll need more information before I can help you with this task.";
    const r = extractToolCallsFromText("text", ["read_file"]);
    expect(r.toolCalls.length).toBe(0);
    void text; // satisfy lint
  });

  it("returns empty for empty input", () => {
    const r = extractToolCallsFromText("", ["read_file"]);
    expect(r.toolCalls).toEqual([]);
  });
});
