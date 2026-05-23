import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeCommandTool } from "../src/tools/executeCommand.js";

// Default mock: gate returns ok so existing tests are unaffected.
vi.mock("../src/tools/tierkitGates.js", () => ({
  gateDangerousCommand: vi.fn(async () => ({ severity: "ok", matched: [] })),
}));

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-ec-env-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

function ctx() { return { cwd: workspace, tierkitBaseUrl: "http://127.0.0.1:0" }; }

describe("executeCommandTool envelope", () => {
  it("returns success envelope for a small command", async () => {
    const res = await executeCommandTool.execute({ command: "echo hello" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(true);
    expect(env.tool).toBe("execute_command");
    expect(env.data.exitCode).toBe(0);
    expect(env.data.stdout.trim()).toBe("hello");
    expect(env.truncated).toBe(false);
    expect(env.next).toBeUndefined();
  });

  // Windows cmd.exe (used by shell:true) has an 8191-char command line limit;
  // a 70KB printf literal trips ENAMETOOLONG before the shell even spawns.
  // The truncation logic is platform-agnostic; verify it on POSIX only.
  (process.platform === "win32" ? it.skip : it)("truncated:true has no next, only warnings (deterministic-continuation impossible)", async () => {
    // Generate enough output to exceed maxStdoutBytes default (64KB)
    const big = "a".repeat(70 * 1024);
    const res = await executeCommandTool.execute(
      { command: `printf '${big}'`, maxStdoutBytes: 1024 },   // explicit small cap to force truncation
      ctx() as any,
    );
    const env = JSON.parse(res.content);
    expect(env.truncated).toBe(true);
    expect(env.next).toBeUndefined();
    expect(env.warnings).toContain(
      "command output was truncated. Re-run with narrower scope or redirect output to a file and use read_file with a cursor."
    );
    expect(env.size.stdoutBytesReturned).toBeGreaterThan(0);
    expect(env.size.stdoutTruncated).toBe(true);
  });

  it("blocks dangerous commands via gateDangerousCommand (regression from v0.15)", async () => {
    // Mock the gate to force a block
    const gate = await import("../src/tools/tierkitGates.js");
    const spy = vi.spyOn(gate, "gateDangerousCommand").mockResolvedValueOnce({
      severity: "block",
      matched: [{ id: "rm-rf-root", reason: "destructive" }],
    } as any);
    const res = await executeCommandTool.execute({ command: "rm -rf /" }, ctx() as any);
    const env = JSON.parse(res.content);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("dangerous-command-blocked");
    spy.mockRestore();
  });
});
