/**
 * Tests for Fix C (v0.14.2): subscription-CLI timeout → explicit error, no auto-fallback.
 *
 * When the provider throws with code "cli-timeout" AND isSingleShot is true:
 *   - AgentLoop emits an `error` event with code "subscription-cli-timeout"
 *   - AgentLoop does NOT retry with another profile
 *   - AgentLoop emits turn_end(error) and task_complete
 */
import { describe, it, expect } from "vitest";
import { runAgent, type AgentEvent } from "../src/index.js";

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("runAgent — subscription-CLI timeout surfacing", () => {
  it("emits error with code subscription-cli-timeout when cli-timeout thrown in single-shot mode", async () => {
    const events = await collect(
      runAgent(
        { task: "large refactor", isSingleShot: true },
        {
          callModel: async () => {
            const err = new Error("cli-timeout: process timed out after 180000ms");
            (err as Error & { code: string }).code = "cli-timeout";
            throw err;
          },
        },
      ),
    );
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    if (errEvent?.type === "error") {
      expect(errEvent.code).toBe("subscription-cli-timeout");
      expect(errEvent.message).toContain("timed out");
      expect(errEvent.message).toContain("smaller pieces");
    }
  });

  it("does NOT auto-fallback: model is called exactly once on cli-timeout in single-shot mode", async () => {
    let callCount = 0;
    const events = await collect(
      runAgent(
        { task: "large refactor", isSingleShot: true, maxTurns: 5 },
        {
          callModel: async () => {
            callCount++;
            const err = new Error("cli-timeout: timed out after 180s");
            (err as Error & { code: string }).code = "cli-timeout";
            throw err;
          },
        },
      ),
    );
    expect(callCount).toBe(1);
    // Should still terminate gracefully
    const complete = events.find((e) => e.type === "task_complete");
    expect(complete).toBeDefined();
  });

  it("emits turn_end with reason error on cli-timeout in single-shot mode", async () => {
    const events = await collect(
      runAgent(
        { task: "task", isSingleShot: true },
        {
          callModel: async () => {
            const err = new Error("timed out after 180000ms");
            (err as Error & { code: string }).code = "cli-timeout";
            throw err;
          },
        },
      ),
    );
    const turnEnd = events.find((e) => e.type === "turn_end");
    expect(turnEnd).toBeDefined();
    if (turnEnd?.type === "turn_end") {
      expect(turnEnd.reason).toBe("error");
    }
  });

  it("non-single-shot cli-timeout still surfaces as generic model-call-failed error", async () => {
    // Without isSingleShot, a cli-timeout error falls through to the generic handler
    const events = await collect(
      runAgent(
        { task: "task", isSingleShot: false },
        {
          callModel: async () => {
            const err = new Error("cli-timeout: timed out");
            (err as Error & { code: string }).code = "cli-timeout";
            throw err;
          },
        },
      ),
    );
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    // In non-single-shot mode, it falls to the generic handler which uses the error's code
    if (errEvent?.type === "error") {
      // Generic handler passes through the error code
      expect(errEvent.code).toBe("cli-timeout");
    }
  });
});
