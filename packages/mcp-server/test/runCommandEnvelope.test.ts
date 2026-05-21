import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandTool } from "../src/tools/runCommand.js";

let workspace: string;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcp-rc-env-")); });
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

describe("MCP tierkit.run_command envelope", () => {
  it("returns success envelope for safe command", async () => {
    const r = await runCommandTool({ workspaceRoot: workspace, command: "echo hello" });
    expect(r.ok).toBe(true);
    expect((r as any).tool).toBe("tierkit.run_command");
    expect((r as any).data.exitCode).toBe(0);
  });

  it("truncated:true has NO next but has the fixed warning", async () => {
    const r = await runCommandTool({
      workspaceRoot: workspace,
      command: "yes | head -c 5000",
      maxStdoutBytes: 1024,
    });
    expect(r.ok).toBe(true);
    expect((r as any).truncated).toBe(true);
    expect((r as any).next).toBeUndefined();
    expect((r as any).warnings).toContain(
      "command output was truncated. Re-run with narrower scope or redirect output to a file and use read_file with a cursor."
    );
    expect((r as any).size.stdoutTruncated).toBe(true);
  });
});
