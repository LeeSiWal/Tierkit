/**
 * Tests for the edit-intent + force-edit recovery path. Verifies that a model which
 * answers the first turn with no tool calls gets retried with restricted tools +
 * tool_choice: "required" when (a) the user's task matches edit-intent verbs, or
 * (b) the explicit `forceEdit: true` input is set.
 */
import { describe, it, expect } from "vitest";
import { runAgent } from "../src/AgentLoop.js";
import type { ModelCallRequest, ModelCallResponse } from "../src/AgentLoop.js";
import type { AgentEvent } from "../src/types.js";

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("AgentLoop force-edit stall recovery", () => {
  it("retries with tools + tool_choice when intent matches and first turn stalled", async () => {
    const seenRequests: ModelCallRequest[] = [];
    let turn = 0;
    const callModel = async (req: ModelCallRequest): Promise<ModelCallResponse> => {
      seenRequests.push(req);
      turn++;
      if (turn === 1) {
        // Model just describes — no tool calls.
        return { text: "Sure, I would modify foo.ts like this... (no tool call)" };
      }
      // After force retry, model emits task_complete (we just check the request shape)
      return { text: "<task_complete>done</task_complete>" };
    };

    const events = await collect(
      runAgent({ task: "fix the bug in src/foo.ts", cwd: "/tmp" }, { callModel }),
    );

    // First request should NOT have tools/tool_choice (default behavior).
    expect(seenRequests[0]!.tools).toBeUndefined();
    expect(seenRequests[0]!.tool_choice).toBeUndefined();
    // Second request (force retry) SHOULD have both.
    expect(seenRequests[1]!.tools).toBeDefined();
    expect(seenRequests[1]!.tool_choice).toBe("required");
    // Forced tools should be ONLY write-class.
    const forcedNames = (seenRequests[1]!.tools ?? []).map((t) => t.function.name).sort();
    expect(forcedNames).toEqual(["apply_diff", "search_and_replace", "write_file"]);
    // Loop should have continued past the stall (not emitted turn_end with no_tool_calls
    // on the FIRST stall — only the eventual task_complete should appear).
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(0);
    expect(events.find((e) => e.type === "task_complete")).toBeDefined();
  });

  it("does NOT retry when intent doesn't match and forceEdit is false", async () => {
    const seenRequests: ModelCallRequest[] = [];
    const callModel = async (req: ModelCallRequest): Promise<ModelCallResponse> => {
      seenRequests.push(req);
      return { text: "Here's an explanation of how the code works..." };
    };

    const events = await collect(
      runAgent({ task: "explain how this code works", cwd: "/tmp" }, { callModel }),
    );

    // Only one model call — the stall caused turn_end immediately.
    expect(seenRequests).toHaveLength(1);
    expect(events.find((e) => e.type === "turn_end")).toBeDefined();
  });

  it("forceEdit: true triggers retry even when task has no edit-intent keywords", async () => {
    const seenRequests: ModelCallRequest[] = [];
    let turn = 0;
    const callModel = async (req: ModelCallRequest): Promise<ModelCallResponse> => {
      seenRequests.push(req);
      turn++;
      if (turn === 1) return { text: "Looking at this..." };
      return { text: "<task_complete>done</task_complete>" };
    };

    await collect(
      runAgent({ task: "just look at this file", cwd: "/tmp", forceEdit: true }, { callModel }),
    );

    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[1]!.tool_choice).toBe("required");
  });

  it("retries at most once per task even if the forced turn also stalls", async () => {
    const seenRequests: ModelCallRequest[] = [];
    const callModel = async (req: ModelCallRequest): Promise<ModelCallResponse> => {
      seenRequests.push(req);
      // Model keeps refusing to call any tool.
      return { text: "I cannot help with that." };
    };

    const events = await collect(
      runAgent({ task: "fix the bug", cwd: "/tmp" }, { callModel }),
    );

    // Exactly TWO requests: original + one force-retry. No infinite loop.
    expect(seenRequests).toHaveLength(2);
    expect(events.find((e) => e.type === "turn_end")).toBeDefined();
  });

  it("Korean edit-intent ('수정') triggers retry", async () => {
    const seenRequests: ModelCallRequest[] = [];
    let turn = 0;
    const callModel = async (req: ModelCallRequest): Promise<ModelCallResponse> => {
      seenRequests.push(req);
      turn++;
      if (turn === 1) return { text: "다음과 같이 바꾸면 됩니다..." };
      return { text: "<task_complete>완료</task_complete>" };
    };

    await collect(runAgent({ task: "함수를 수정해줘", cwd: "/tmp" }, { callModel }));
    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[1]!.tool_choice).toBe("required");
  });
});
