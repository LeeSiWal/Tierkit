import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

/**
 * v0.22.5 regression test for the host-info auto-heal hook.
 *
 * Scenario: VS Code auto-updates the Tierkit extension. context.extensionPath
 * now points to the NEW folder; the existing .mcp.json still references the
 * OLD path. Until the user clicks Connect, Claude Code may fail to spawn the
 * MCP server (and silently produces 0 tool calls — the symptom that motivated
 * this fix). The Extension fires POST /v1/claude-code/host-info on every
 * activation; the daemon should detect the path drift and rewrite the entry
 * in place — without ever creating a new entry the user didn't opt into.
 */
describe("/v1/claude-code/host-info — auto-heal stale cliPath", () => {
  let workspace: string;
  let fakeHome: string;
  let running: RunningServer;
  let url: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-autoheal-ws-"));
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-autoheal-home-"));
    running = await startServer({ port: 0, host: "127.0.0.1", cwd: workspace, homeDir: fakeHome });
    url = `http://${running.address}:${running.port}`;
  });

  afterEach(async () => {
    await running.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it("rewrites a stale workspace .mcp.json entry when host-info reports a new cliPath", async () => {
    // Pre-populate with the OLD extension's path (simulating post-update state).
    const stale = {
      mcpServers: {
        tierkit: {
          type: "stdio",
          command: "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
          args: [
            "/Users/dev/.vscode/extensions/leesiwal.tierkit-vscode-0.22.3/cli/index.js",
            "mcp", "serve", "--workspace", workspace,
          ],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    };
    await fs.writeFile(path.join(workspace, ".mcp.json"), JSON.stringify(stale));

    const newCliPath = "/Users/dev/.vscode/extensions/leesiwal.tierkit-vscode-0.22.5/cli/index.js";
    const r = await fetch(`${url}/v1/claude-code/host-info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPath: newCliPath, nodeBinary: "/bin/sh" }),
    });
    expect(r.ok).toBe(true);
    const body = await r.json();
    expect(body.autoHealed.workspace).toBe(true);

    const after = JSON.parse(await fs.readFile(path.join(workspace, ".mcp.json"), "utf8"));
    expect(after.mcpServers.tierkit.args[0]).toBe(newCliPath);
  });

  it("does NOT create an entry when the user never wired up MCP (no existing .mcp.json)", async () => {
    const r = await fetch(`${url}/v1/claude-code/host-info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPath: "/some/path/cli.js", nodeBinary: "/bin/sh" }),
    });
    expect(r.ok).toBe(true);
    const body = await r.json();
    expect(body.autoHealed.workspace).toBe(false);
    expect(body.autoHealed.global).toBe(false);
    // No .mcp.json appears out of nowhere — auto-heal must never opt a user in.
    await expect(fs.access(path.join(workspace, ".mcp.json"))).rejects.toThrow();
    await expect(fs.access(path.join(fakeHome, ".claude.json"))).rejects.toThrow();
  });

  it("does nothing when no cliPath was reported (legacy daemons / first activation racing)", async () => {
    const r = await fetch(`${url}/v1/claude-code/host-info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.ok).toBe(true);
    const body = await r.json();
    // No work attempted on either scope when we don't even have a new path
    // to write — same as before-this-fix behavior.
    expect(body.autoHealed.workspace).toBe(false);
    expect(body.autoHealed.global).toBe(false);
  });
});
