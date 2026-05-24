import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  logMcpActivity,
  setActivityListener,
  readMcpActivity,
} from "../src/mcp/activityLog.js";

describe("setActivityListener", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-activity-"));
  });
  afterEach(async () => {
    setActivityListener(null);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("invokes the listener with workspaceRoot after logMcpActivity appends", async () => {
    const calls: string[] = [];
    setActivityListener((root) => { calls.push(root); });
    await logMcpActivity(tmp, {
      tool: "tierkit.get_file_digest",
      ok: true, code: null, durationMs: 5, redactionHits: 0,
      inputSummary: { path: "x.ts" }, outputSummary: { beforeTokens: 100, afterTokens: 10, savedTokens: 90 },
    });
    expect(calls).toEqual([tmp]);
    const entries = await readMcpActivity(tmp);
    expect(entries).toHaveLength(1);
  });

  it("does not propagate listener exceptions — entry is still appended", async () => {
    setActivityListener(() => { throw new Error("boom"); });
    await expect(logMcpActivity(tmp, {
      tool: "tierkit.compress_command",
      ok: true, code: null, durationMs: 1, redactionHits: 0,
      inputSummary: null, outputSummary: null,
    })).resolves.toBeUndefined();
    const entries = await readMcpActivity(tmp);
    expect(entries).toHaveLength(1);
  });

  it("setActivityListener(null) clears a previously registered listener", async () => {
    const calls: string[] = [];
    setActivityListener((root) => { calls.push(root); });
    setActivityListener(null);
    await logMcpActivity(tmp, {
      tool: "tierkit.compress_command",
      ok: true, code: null, durationMs: 1, redactionHits: 0,
      inputSummary: null, outputSummary: null,
    });
    expect(calls).toEqual([]);
  });
});
