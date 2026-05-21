import { describe, it, expect } from "vitest";
import {
  makeSuccessEnvelope,
  makeFailureEnvelope,
  type ToolResultEnvelope,
  TOOL_RESULT_ENVELOPE_VERSION,
} from "../src/tools/envelope.js";

describe("envelope shape", () => {
  it("VERSION constant equals 'tool-result-envelope.v1'", () => {
    expect(TOOL_RESULT_ENVELOPE_VERSION).toBe("tool-result-envelope.v1");
  });

  it("makeSuccessEnvelope produces ok/tool/version/data with default flags", () => {
    const env = makeSuccessEnvelope("read_file", { path: "a.ts", content: "x" });
    expect(env.ok).toBe(true);
    expect(env.tool).toBe("read_file");
    expect(env.version).toBe("tool-result-envelope.v1");
    expect(env.data).toEqual({ path: "a.ts", content: "x" });
    expect(env.truncated).toBe(false);
  });

  it("makeSuccessEnvelope carries truncated + range + size + next when provided", () => {
    const env = makeSuccessEnvelope(
      "read_file",
      { path: "a.ts", content: "lines 1-300" },
      {
        truncated: true,
        range: { startLine: 1, endLine: 300 },
        size: { linesReturned: 300, totalLines: 900, remainingLines: 600 },
        next: {
          cursor: "AAAA",
          suggestedCall: { tool: "read_file", args: { cursor: "AAAA" } },
        },
      },
    );
    expect(env.truncated).toBe(true);
    expect(env.range?.startLine).toBe(1);
    expect(env.size?.totalLines).toBe(900);
    expect(env.next?.cursor).toBe("AAAA");
  });

  it("makeFailureEnvelope produces ok:false/tool/version/error", () => {
    const env = makeFailureEnvelope("read_file", "not-found", "file does not exist: src/x.ts");
    expect(env.ok).toBe(false);
    expect(env.tool).toBe("read_file");
    expect(env.version).toBe("tool-result-envelope.v1");
    expect(env.error.code).toBe("not-found");
    expect(env.error.message).toBe("file does not exist: src/x.ts");
  });

  it("warnings are preserved on both arms", () => {
    const ok = makeSuccessEnvelope("search_files", { matches: [] }, { warnings: ["pattern matches every line"] });
    const fail = makeFailureEnvelope("read_file", "stale-cursor", "file changed", ["cursor was issued at 2026-01-01"]);
    expect(ok.warnings).toEqual(["pattern matches every line"]);
    expect(fail.warnings).toEqual(["cursor was issued at 2026-01-01"]);
  });

  it("INVARIANT: if truncated=true, next or warnings MUST be present", () => {
    // The invariant is documented and enforced by tool implementations, not by
    // makeSuccessEnvelope itself (which is a value constructor, not a validator).
    // This test documents the contract for grep-discovery.
    const truncatedWithNext = makeSuccessEnvelope("read_file", { path: "a", content: "" }, {
      truncated: true,
      next: { cursor: "x", suggestedCall: { tool: "read_file", args: {} } },
    });
    const truncatedWithWarning = makeSuccessEnvelope("run_command", { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }, {
      truncated: true,
      warnings: ["truncated, re-run with narrower scope"],
    });
    expect(truncatedWithNext.next).toBeDefined();
    expect(truncatedWithWarning.warnings?.length).toBeGreaterThan(0);
  });
});
