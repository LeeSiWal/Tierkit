import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeTierkitMcpSavings } from "../src/runtime/tierkitSavings.js";

// Force a non-UTC timezone so the assertion would fail trivially on a UTC
// CI runner if we used UTC midnight. KST is UTC+9 and has no DST.
const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "Asia/Seoul";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("computeTierkitMcpSavings — today window honors local TZ", () => {
  it("windowStart aligns to local midnight, not UTC midnight", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tk-tz-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-tz-home-"));

    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });

    // The returned UTC instant should correspond to local midnight today.
    // Under setUTCHours(0,...), the instant is UTC midnight, which in KST is
    // 09:00 — so getHours() would return 9, not 0. That's the bug a KST user
    // sees as "the savings card resets every day at 9 AM local time".
    const startInstant = new Date(r.windowStart);
    expect(startInstant.getHours()).toBe(0);
    expect(startInstant.getMinutes()).toBe(0);
    expect(startInstant.getSeconds()).toBe(0);
    expect(startInstant.getMilliseconds()).toBe(0);
  });

  it("counts an activity from earlier today (local) even when its UTC ts is yesterday", async () => {
    // Scenario reproducing the live bug we observed:
    //   user is in KST. Wall-clock now ≈ KST 10:00 = UTC 01:00 (today UTC).
    //   user did a tierkit MCP call at KST 06:00 today = UTC 21:00 yesterday.
    //   Under setUTCHours(0,...), windowStart = UTC today 00:00 — yesterday's
    //   UTC 21:00 ts is BEFORE the window, so the call is excluded → toolCallCount=0.
    //   Under setHours(0,...), windowStart = local today 00:00 = UTC 15:00
    //   yesterday — UTC 21:00 yesterday is AFTER → counted → toolCallCount=1.
    //
    // We don't mock the clock — we use the real current time and choose an
    // offset that guarantees the call ts is "earlier today local" yet might
    // be "yesterday UTC" depending on wall-clock. The assertion holds either
    // way under the fix; under the bug it fails when local hour > UTC offset.
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tk-tz2-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-tz2-home-"));

    // Compute "local today 06:00" as a real instant.
    const local6am = new Date();
    local6am.setHours(6, 0, 0, 0);
    // Skip the test in the narrow window before 06:00 local where this ts
    // would be in the future — vitest won't actually be running then in CI,
    // but be safe in case a contributor runs it at 03:00.
    if (local6am.getTime() > Date.now()) {
      return;
    }

    const dir = path.join(ws, ".tierkit", "runtime");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, "usage.jsonl"),
      JSON.stringify({
        ts: local6am.toISOString(),
        type: "mcp-tool",
        workspaceRoot: ws,
        tool: "tierkit.compress_command",
        ok: true,
        code: null,
        durationMs: 5,
        redactionHits: 0,
        inputSummary: {},
        outputSummary: { beforeTokens: 1000, afterTokens: 100, savedTokens: 900 },
        clientName: "claude-code",
      }) + "\n",
    );

    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });
    expect(r.toolCallCount).toBe(1);
    expect(r.savedTokensTotal).toBe(900);
  });
});
