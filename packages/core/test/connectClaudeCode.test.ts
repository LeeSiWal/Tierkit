import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  connectClaudeCode,
  disconnectClaudeCode,
  claudeCodeStatus,
} from "../src/usecases/connectClaudeCode.js";

let workspace: string;
let fakeHome: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-cc-ws-"));
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-cc-home-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe("connectClaudeCode", () => {
  it("creates ~/.claude.json with tierkit MCP entry (scope=global)", async () => {
    const r = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "global",
      instructionsLevel: "light",
      homeDir: fakeHome,
    });
    expect(r.ok).toBe(true);
    expect(r.mcpConfigPath).toBe(path.join(fakeHome, ".claude.json"));
    const cfg = JSON.parse(await fs.readFile(r.mcpConfigPath, "utf8"));
    // v0.20.6: command may be auto-resolved to an absolute path. Accept either
    // the bare name OR an absolute path ending in /tierkit (POSIX) or
    // \tierkit(.exe/.cmd) (Windows).
    const cmd = cfg.mcpServers.tierkit.command;
    expect(
      cmd === "tierkit" ||
      /[\/\\]tierkit(\.[a-z]+)?$/i.test(cmd),
    ).toBe(true);
    expect(cfg.mcpServers.tierkit.args).toContain("mcp");
    expect(cfg.mcpServers.tierkit.args).toContain("serve");
    expect(cfg.mcpServers.tierkit.args).toContain(workspace);
  });

  it("creates .mcp.json in workspace (scope=workspace)", async () => {
    const r = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "light",
      homeDir: fakeHome,
    });
    expect(r.mcpConfigPath).toBe(path.join(workspace, ".mcp.json"));
    const cfg = JSON.parse(await fs.readFile(r.mcpConfigPath, "utf8"));
    expect(cfg.mcpServers.tierkit).toBeDefined();
  });

  it("merges into existing ~/.claude.json without touching other servers", async () => {
    const existing = {
      mcpServers: {
        "notebooklm-mcp": { type: "stdio", command: "notebooklm-mcp" },
      },
      otherField: { keep: "this" },
    };
    await fs.writeFile(path.join(fakeHome, ".claude.json"), JSON.stringify(existing));
    await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "global",
      instructionsLevel: "none",
      homeDir: fakeHome,
    });
    const cfg = JSON.parse(await fs.readFile(path.join(fakeHome, ".claude.json"), "utf8"));
    expect(cfg.mcpServers["notebooklm-mcp"].command).toBe("notebooklm-mcp");
    expect(cfg.mcpServers.tierkit).toBeDefined();
    expect(cfg.otherField).toEqual({ keep: "this" });
  });

  it("writes CLAUDE.md with marker block when instructionsLevel=light", async () => {
    const r = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "light",
      homeDir: fakeHome,
    });
    expect(r.claudeMdWritten).toBe(true);
    const md = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
    expect(md).toContain("TIERKIT MCP INSTRUCTIONS");
    expect(md).toContain("tierkit.compress_command");
    expect(md).toContain("/TIERKIT MCP INSTRUCTIONS");
  });

  it("does not write CLAUDE.md when instructionsLevel=none", async () => {
    const r = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "none",
      homeDir: fakeHome,
    });
    expect(r.claudeMdWritten).toBe(false);
    await expect(fs.access(path.join(workspace, "CLAUDE.md"))).rejects.toThrow();
  });

  it("preserves existing CLAUDE.md content above and below the marker block", async () => {
    const original = "# My Project\n\nExisting docs here.\n";
    await fs.writeFile(path.join(workspace, "CLAUDE.md"), original);
    await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "light",
      homeDir: fakeHome,
    });
    const md = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
    expect(md).toContain("# My Project");
    expect(md).toContain("Existing docs here.");
    expect(md).toContain("TIERKIT MCP INSTRUCTIONS");
  });

  it("is idempotent: connecting twice does not duplicate the marker block", async () => {
    await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "light",
      homeDir: fakeHome,
    });
    const first = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
    await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "light",
      homeDir: fakeHome,
    });
    const second = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
    const occurrences = (second.match(/TIERKIT MCP INSTRUCTIONS/g) || []).length;
    // Begin + end marker only = 2 occurrences (NOT 4)
    expect(occurrences).toBe(2);
    expect(first).toBe(second);
  });

  it("reports alreadyConnected=true when re-running", async () => {
    await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "none",
      homeDir: fakeHome,
    });
    const r2 = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "none",
      homeDir: fakeHome,
    });
    expect(r2.alreadyConnected).toBe(true);
  });

  it("full instructions level produces longer block than light", async () => {
    await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "light",
      homeDir: fakeHome,
    });
    const lightMd = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
    await fs.rm(path.join(workspace, "CLAUDE.md"));
    await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "full",
      homeDir: fakeHome,
    });
    const fullMd = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
    expect(fullMd.length).toBeGreaterThan(lightMd.length);
    expect(fullMd).toContain("required workflow");
  });
});

describe("disconnectClaudeCode", () => {
  it("removes tierkit MCP entry without touching others", async () => {
    const existing = {
      mcpServers: {
        "notebooklm-mcp": { type: "stdio", command: "notebooklm-mcp" },
      },
    };
    await fs.writeFile(path.join(fakeHome, ".claude.json"), JSON.stringify(existing));
    await connectClaudeCode({ workspaceRoot: workspace, scope: "global", instructionsLevel: "none", homeDir: fakeHome });
    const r = await disconnectClaudeCode({ workspaceRoot: workspace, scope: "global", homeDir: fakeHome });
    expect(r.mcpEntryRemoved).toBe(true);
    const cfg = JSON.parse(await fs.readFile(path.join(fakeHome, ".claude.json"), "utf8"));
    expect(cfg.mcpServers.tierkit).toBeUndefined();
    expect(cfg.mcpServers["notebooklm-mcp"]).toBeDefined();
  });

  it("strips CLAUDE.md marker block while preserving surrounding content", async () => {
    const original = "# My Project\n\nKeep me.\n";
    await fs.writeFile(path.join(workspace, "CLAUDE.md"), original);
    await connectClaudeCode({ workspaceRoot: workspace, scope: "workspace", instructionsLevel: "light", homeDir: fakeHome });
    const r = await disconnectClaudeCode({ workspaceRoot: workspace, scope: "workspace", homeDir: fakeHome });
    expect(r.claudeMdStripped).toBe(true);
    const md = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
    expect(md).toContain("# My Project");
    expect(md).toContain("Keep me.");
    expect(md).not.toContain("TIERKIT MCP INSTRUCTIONS");
  });

  it("deletes CLAUDE.md if only the marker block was in it", async () => {
    await connectClaudeCode({ workspaceRoot: workspace, scope: "workspace", instructionsLevel: "light", homeDir: fakeHome });
    await disconnectClaudeCode({ workspaceRoot: workspace, scope: "workspace", homeDir: fakeHome });
    await expect(fs.access(path.join(workspace, "CLAUDE.md"))).rejects.toThrow();
  });

  it("is safe when nothing is connected (no-op)", async () => {
    const r = await disconnectClaudeCode({ workspaceRoot: workspace, scope: "global", homeDir: fakeHome });
    expect(r.mcpEntryRemoved).toBe(false);
    expect(r.claudeMdStripped).toBe(false);
  });
});

describe("connectClaudeCode binary resolution", () => {
  it("trusts caller-supplied absolute paths and writes them verbatim", async () => {
    // /bin/sh always exists on POSIX runners; on Windows CI this test is
    // implicitly skipped via the platform guard below.
    if (process.platform === "win32") return;
    const r = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "none",
      homeDir: fakeHome,
      tierkitBinary: "/bin/sh",
    });
    expect(r.verification.resolvedCommand).toBe("/bin/sh");
    const cfg = JSON.parse(await fs.readFile(r.mcpConfigPath, "utf8"));
    expect(cfg.mcpServers.tierkit.command).toBe("/bin/sh");
    expect(r.verification.binaryLaunchable).toBe(true);
  });

  it("reports binaryLaunchable=false for a missing absolute path", async () => {
    const fake = path.join(workspace, "definitely-not-here");
    const r = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "none",
      homeDir: fakeHome,
      tierkitBinary: fake,
    });
    expect(r.verification.binaryLaunchable).toBe(false);
    expect(r.verification.binaryError).toMatch(/not found|spawn|ENOENT/i);
  });

  it("verification.fileWritten + fileContainsEntry true after successful connect", async () => {
    const r = await connectClaudeCode({
      workspaceRoot: workspace,
      scope: "workspace",
      instructionsLevel: "none",
      homeDir: fakeHome,
      tierkitBinary: process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
    });
    expect(r.verification.fileWritten).toBe(true);
    expect(r.verification.fileContainsEntry).toBe(true);
  });
});

describe("claudeCodeStatus", () => {
  it("reports nothing connected on fresh workspace", async () => {
    const s = await claudeCodeStatus({ workspaceRoot: workspace, homeDir: fakeHome });
    expect(s.connectedGlobal).toBe(false);
    expect(s.connectedWorkspace).toBe(false);
    expect(s.instructionsInClaudeMd).toBe(false);
  });

  it("reports connected after connectClaudeCode", async () => {
    await connectClaudeCode({ workspaceRoot: workspace, scope: "global", instructionsLevel: "light", homeDir: fakeHome });
    const s = await claudeCodeStatus({ workspaceRoot: workspace, homeDir: fakeHome });
    expect(s.connectedGlobal).toBe(true);
    expect(s.connectedWorkspace).toBe(false);
    expect(s.instructionsInClaudeMd).toBe(true);
  });

  it("reports both scopes independently", async () => {
    await connectClaudeCode({ workspaceRoot: workspace, scope: "workspace", instructionsLevel: "none", homeDir: fakeHome });
    const s = await claudeCodeStatus({ workspaceRoot: workspace, homeDir: fakeHome });
    expect(s.connectedGlobal).toBe(false);
    expect(s.connectedWorkspace).toBe(true);
  });
});
