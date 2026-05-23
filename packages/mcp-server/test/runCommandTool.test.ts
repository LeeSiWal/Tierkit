import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandTool } from "../src/tools/runCommand.js";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-runcmd-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("tierkit.run_command", () => {
  it("runs a safe command and returns stdout", async () => {
    await fs.writeFile(path.join(workspace, "hello.txt"), "hi");
    const r = await runCommandTool({ workspaceRoot: workspace, command: "ls" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // v0.16 envelope: stdout lives in data.stdout
    expect((r as any).data.stdout).toContain("hello.txt");
    expect((r as any).data.exitCode).toBe(0);
  });

  it("blocks dangerous commands", async () => {
    const r = await runCommandTool({ workspaceRoot: workspace, command: "rm -rf /" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // v0.16 envelope: failure uses error.code
    expect((r as any).error.code).toBe("command-blocked");
  });

  it("returns approval-required for non-safe non-blocked commands WITHOUT executing them", async () => {
    // Use a sentinel side-effect file the command would create if it actually ran.
    // After the call returns approval-required, the file must NOT exist.
    // npm publish is classified "warn" (approval-required), not "block" or "ok".
    const sentinel = path.join(workspace, "did-it-run.txt");
    const r = await runCommandTool({
      workspaceRoot: workspace,
      command: `npm publish && touch ${sentinel}`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r as any).error.code).toBe("approval-required");
    // classification is surfaced in warnings in v0.16 envelope
    expect((r as any).warnings?.some((w: string) => w.startsWith("classification:"))).toBe(true);
    // No `approval` envelope on run_command in v0.15.0.
    expect((r as any).approval).toBeUndefined();
    // The command was NOT executed — sentinel must be absent.
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // On Windows runners with Git Bash on PATH, `pwd` returns a POSIX-style path
  // (e.g. /c/Users/...) while fs.realpath returns the native Windows path
  // (C:\Users\...). The cwd-locking behavior under test is the same; the path-
  // format mismatch is incidental to the testing harness. Verify on POSIX.
  (process.platform === "win32" ? it.skip : it)("ignores caller-supplied cwd (always workspace)", async () => {
    // Even if a caller smuggled a cwd, the implementation must still set workspaceRoot.
    // We don't expose a cwd input, but verify pwd output equals workspace.
    const r = await runCommandTool({ workspaceRoot: workspace, command: "pwd" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.stdout.trim()).toBe(await fs.realpath(workspace));
  });

  it("does not pass ANTHROPIC_API_KEY through env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-test";
    try {
      const r = await runCommandTool({ workspaceRoot: workspace, command: "env" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r as any).data.stdout).not.toContain("sk-ant-secret-test");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("redacts secret-looking stdout", async () => {
    const r = await runCommandTool({
      workspaceRoot: workspace,
      command: 'printf "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n"',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.stdout).not.toMatch(/sk-ant-api03-[A-Z]/);
  });

  it("truncates stdout exceeding maxStdoutBytes", async () => {
    const r = await runCommandTool({
      workspaceRoot: workspace,
      command: "yes | head -c 2000000",
      maxStdoutBytes: 1000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as any).data.stdout.length).toBeLessThanOrEqual(1500); // includes truncation marker bytes
    expect((r as any).truncated).toBe(true);
  });

  // Windows kill semantics let the spawned `sleep` (via Git Bash) hold an open
  // handle on the workspace tmpdir, so the afterEach rmdir trips EBUSY before
  // the test can clean up. The timeout behavior itself is the same; verify
  // on POSIX. (See profileViability.subprocess.test.ts for the same kill-
  // semantics caveat applied to a different consumer.)
  (process.platform === "win32" ? it.skip : it)("times out a long-running command", async () => {
    const r = await runCommandTool({
      workspaceRoot: workspace,
      command: "sleep 5",
      timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r as any).error.code).toBe("command-timeout");
  });
});
