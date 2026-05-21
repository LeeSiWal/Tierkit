/**
 * Tests for Fix A (v0.14.2): single-shot mode for subscription-CLI providers.
 *
 * When `isSingleShot: true`, AgentLoop must:
 *   - NOT parse XML tool calls from the response text
 *   - Emit `assistant_text` exactly once with the raw model output
 *   - Emit the SINGLE_SHOT_FOOTER as a second `assistant_text` event
 *   - Emit `task_complete` on turn 1 (no loop)
 *   - NOT emit any `tool_call` events
 */
import { describe, it, expect } from "vitest";
import { runAgent, SINGLE_SHOT_FOOTER, type AgentEvent } from "../src/index.js";

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("runAgent — single-shot mode (subscription-CLI providers)", () => {
  const XML_RESPONSE =
    "I'll look at the files for you.\n" +
    "<list_files><path>.</path></list_files>\n" +
    "That's the structure of the project.";

  it("does NOT execute XML tool tags in single-shot mode", async () => {
    const events = await collect(
      runAgent(
        { task: "list files", isSingleShot: true, maxTurns: 5 },
        { callModel: async () => ({ text: XML_RESPONSE }) },
      ),
    );
    // No tool_call event should fire
    expect(events.find((e) => e.type === "tool_call")).toBeUndefined();
  });

  it("emits assistant_text with the raw response (XML included)", async () => {
    const events = await collect(
      runAgent(
        { task: "list files", isSingleShot: true, maxTurns: 5 },
        { callModel: async () => ({ text: XML_RESPONSE }) },
      ),
    );
    const textEvents = events.filter((e) => e.type === "assistant_text");
    // First assistant_text should contain the raw XML response
    const first = textEvents[0];
    expect(first).toBeDefined();
    if (first?.type === "assistant_text") {
      expect(first.text).toContain("<list_files>");
      expect(first.text).toContain("I'll look at the files for you");
    }
  });

  it("emits the SINGLE_SHOT_FOOTER as the second assistant_text event", async () => {
    const events = await collect(
      runAgent(
        { task: "list files", isSingleShot: true, maxTurns: 5 },
        { callModel: async () => ({ text: XML_RESPONSE }) },
      ),
    );
    const textEvents = events.filter((e) => e.type === "assistant_text");
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    const footer = textEvents[textEvents.length - 1];
    if (footer?.type === "assistant_text") {
      expect(footer.text).toBe(SINGLE_SHOT_FOOTER);
      expect(footer.text).toContain("Single-shot planner output");
    }
  });

  it("emits task_complete on turn 1 (no loop)", async () => {
    let callCount = 0;
    const events = await collect(
      runAgent(
        { task: "plan something", isSingleShot: true, maxTurns: 10 },
        {
          callModel: async () => {
            callCount++;
            return { text: "Here is my plan:\n<read_file><path>foo.ts</path></read_file>" };
          },
        },
      ),
    );
    // Model should only be called once
    expect(callCount).toBe(1);
    const complete = events.find((e) => e.type === "task_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "task_complete") {
      expect(complete.turnCount).toBe(1);
    }
  });

  it("ends with task_complete as the last event", async () => {
    const events = await collect(
      runAgent(
        { task: "review code", isSingleShot: true },
        { callModel: async () => ({ text: "Looks good! Here is my review." }) },
      ),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("task_complete");
  });

  it("SINGLE_SHOT_FOOTER contains the subscription-CLI advisory text", () => {
    expect(SINGLE_SHOT_FOOTER).toContain("Single-shot planner output");
    expect(SINGLE_SHOT_FOOTER).toContain("ANTHROPIC_API_KEY");
    expect(SINGLE_SHOT_FOOTER).toContain("API Keys");
  });
});
