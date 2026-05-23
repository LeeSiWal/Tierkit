import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeTierkitMcpSavings } from "../src/runtime/tierkitSavings.js";

async function makeWorkspace(): Promise<{ ws: string; home: string }> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tk-savings-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-savings-home-"));
  return { ws, home };
}

async function appendActivity(ws: string, entries: object[]): Promise<void> {
  const dir = path.join(ws, ".tierkit", "runtime");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "usage.jsonl");
  for (const e of entries) {
    await fs.appendFile(file, JSON.stringify(e) + "\n");
  }
}

const todayIso = (offsetMinutes = 0): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() + offsetMinutes);
  return d.toISOString();
};

describe("computeTierkitMcpSavings — byClient + byModel", () => {
  it("groups today's activities by clientName", async () => {
    const { ws, home } = await makeWorkspace();
    await appendActivity(ws, [
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 1000, afterTokens: 100, savedTokens: 900 }, clientName: "claude-code" },
      { ts: todayIso(1), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 500, afterTokens: 50, savedTokens: 450 }, clientName: "codex" },
    ]);
    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });
    expect(r.byClient["claude-code"]?.savedTokens).toBe(900);
    expect(r.byClient["codex"]?.savedTokens).toBe(450);
  });

  // Skipped on Windows: encodeCwdForClaudeProjects only swaps "/" and "." which
  // leaves backslashes and the "C:" drive letter in the synthetic project-dir
  // name, producing a path Windows filesystems reject (":" is illegal in names).
  // The production usecase is fine — Claude Code itself encodes the cwd before
  // writing — but this integration test conflates the OS tmp dir with the
  // POSIX-style encoded slug.
  const skipOnWindows = process.platform === "win32" ? it.skip : it;
  skipOnWindows("groups Claude activities by model when jsonl turns exist", async () => {
    const { ws, home } = await makeWorkspace();
    const projDir = path.join(home, ".claude", "projects", ws.replace(/[/.]/g, "-"));
    await fs.mkdir(projDir, { recursive: true });
    const turnTs = new Date(Date.now() - 30_000).toISOString();
    await fs.writeFile(
      path.join(projDir, "11111111-1111-1111-1111-111111111111.jsonl"),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6" }, timestamp: turnTs }) + "\n",
    );
    await appendActivity(ws, [
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 1000, afterTokens: 100, savedTokens: 900 }, clientName: "claude-code" },
    ]);
    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });
    expect(r.byModel["claude-sonnet-4-6"]?.savedTokens).toBe(900);
  });

  it("computes USD per row when baselineInputUsdPerMillion provided", async () => {
    const { ws, home } = await makeWorkspace();
    await appendActivity(ws, [
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 1_000_000, afterTokens: 0, savedTokens: 1_000_000 }, clientName: "claude-code" },
    ]);
    const r = await computeTierkitMcpSavings(ws, 3, { homeDirOverride: home });
    expect(r.byClient["claude-code"]?.estimatedSavedUsd).toBeCloseTo(3, 5);
  });

  it("activity without clientName goes to byClient.unknown", async () => {
    const { ws, home } = await makeWorkspace();
    await appendActivity(ws, [
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 100, afterTokens: 10, savedTokens: 90 } },
    ]);
    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });
    expect(r.byClient["unknown"]?.savedTokens).toBe(90);
  });
});
