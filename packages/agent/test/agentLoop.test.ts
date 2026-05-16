import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, type AgentEvent, type ModelCallResponse } from "../src/index.js";

/**
 * End-to-end agent loop test using a mock model. The mock plays scripted "responses"
 * that exercise each phase of the loop: tool call → result → next turn → task_complete.
 */
describe("runAgent — orchestration", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-agent-loop-"));
    await fs.writeFile(path.join(cwd, "hello.txt"), "world", "utf8");
  });

  async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it("happy path: model reads file, sees content, declares task_complete", async () => {
    const turns: ModelCallResponse[] = [
      { text: "I'll read the file.\n<read_file>\n<path>hello.txt</path>\n</read_file>" },
      { text: "<task_complete><summary>The file contains 'world'.</summary></task_complete>" },
    ];
    const events = await collect(
      runAgent(
        { task: "what's in hello.txt?", cwd, maxTurns: 5 },
        {
          callModel: async () => turns.shift()!,
        },
      ),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("task_start");
    expect(types).toContain("assistant_text");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("task_complete");
    expect(types[types.length - 1]).toBe("task_complete");

    // Verify the tool result content actually includes the file's bytes.
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") {
      expect(result.result.ok).toBe(true);
      expect(result.result.content).toContain("world");
    }
  });

  it("stops at max_turns when the model never says task_complete", async () => {
    // Each turn returns another tool call (a never-ending loop).
    const events = await collect(
      runAgent(
        { task: "loop forever", cwd, maxTurns: 3 },
        {
          callModel: async () => ({ text: "<list_files><path>.</path></list_files>" }),
        },
      ),
    );
    const lastTurnEnd = events.filter((e) => e.type === "turn_end").pop();
    expect(lastTurnEnd).toBeDefined();
    if (lastTurnEnd?.type === "turn_end") expect(lastTurnEnd.reason).toBe("max_turns");
  });

  it("ends with reason 'no_tool_calls' when the model emits plain text and no task_complete", async () => {
    const events = await collect(
      runAgent(
        { task: "say hello", cwd },
        {
          callModel: async () => ({ text: "Hello! I have no tools to call here." }),
        },
      ),
    );
    const turnEnd = events.find((e) => e.type === "turn_end");
    expect(turnEnd).toBeDefined();
    if (turnEnd?.type === "turn_end") expect(turnEnd.reason).toBe("no_tool_calls");
  });

  it("ignores XML tags for unknown tool names (treats them as narrative) and ends with no_tool_calls", async () => {
    // Parser filters out tags whose name isn't a registered tool — these are likely
    // narrative annotations (`<thinking>`, `<note>`) or model confusion, NOT tool intents.
    // The loop sees zero tool calls and ends the turn. The model can correct on a follow-up
    // call if the harness re-prompts, but we don't auto-invent that here.
    const events = await collect(
      runAgent(
        { task: "try a bad tool", cwd, maxTurns: 4 },
        {
          callModel: async () => ({ text: "<bogus_tool><x>1</x></bogus_tool>" }),
        },
      ),
    );
    const turnEnd = events.find((e) => e.type === "turn_end");
    expect(turnEnd).toBeDefined();
    if (turnEnd?.type === "turn_end") expect(turnEnd.reason).toBe("no_tool_calls");
    // No tool_call event should have fired.
    expect(events.find((e) => e.type === "tool_call")).toBeUndefined();
  });

  it("surfaces model-call errors as 'error' events without crashing", async () => {
    const events = await collect(
      runAgent(
        { task: "task", cwd },
        {
          callModel: async () => {
            throw new Error("provider down");
          },
        },
      ),
    );
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.message).toContain("provider down");
    }
  });

  it("invokes approve() for tools marked approval=always (write_file)", async () => {
    let approveCalled = false;
    const events = await collect(
      runAgent(
        {
          task: "make a file",
          cwd,
          maxTurns: 4,
          approve: (call) => {
            approveCalled = true;
            return Promise.resolve(call.name === "write_file");
          },
        },
        {
          callModel: async () => ({
            text: "<write_file><path>created.txt</path><content>hi</content></write_file>",
          }),
        },
      ),
    );
    expect(approveCalled).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_approval_pending");
    expect(types).toContain("tool_approval_resolved");
    // File should have been created.
    const body = await fs.readFile(path.join(cwd, "created.txt"), "utf8");
    expect(body).toBe("hi");
  });

  it("denies destructive tool when approve() returns false; tool reports [denied]", async () => {
    const events = await collect(
      runAgent(
        {
          task: "try to write",
          cwd,
          maxTurns: 4,
          approve: () => Promise.resolve(false),
        },
        {
          callModel: async () => ({
            text: "<write_file><path>nope.txt</path><content>x</content></write_file>",
          }),
        },
      ),
    );
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") {
      expect(result.result.ok).toBe(false);
      expect(result.result.content).toContain("denied");
    }
    // File must NOT exist.
    const exists = await fs.access(path.join(cwd, "nope.txt")).then(() => true, () => false);
    expect(exists).toBe(false);
  });
});
