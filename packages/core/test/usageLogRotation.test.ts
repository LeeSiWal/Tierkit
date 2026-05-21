import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendUsage, type UsageRecord } from "../src/runtime/usageLog.js";

let workspace: string;
let logPath: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usagerot-"));
  logPath = path.join(workspace, "usage.jsonl");
});
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

function makeRecord(profileId = "p1"): UsageRecord {
  return {
    timestamp: new Date().toISOString(),
    profileId,
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    tier: "local-device",
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0,
    latencyMs: 1000,
    ok: true,
  };
}

describe("usage.jsonl auto-trim", () => {
  it("trims to ≤6 MB after appending to a file exceeding 10 MB", async () => {
    const oneLine = JSON.stringify(makeRecord("seed")) + "\n";
    const linesNeeded = Math.ceil((10.5 * 1024 * 1024) / oneLine.length);
    await fs.writeFile(logPath, oneLine.repeat(linesNeeded));
    const beforeSize = (await fs.stat(logPath)).size;
    expect(beforeSize).toBeGreaterThan(10 * 1024 * 1024);

    await appendUsage(logPath, makeRecord("post-trim"));

    const afterSize = (await fs.stat(logPath)).size;
    expect(afterSize).toBeLessThanOrEqual(6 * 1024 * 1024);
    expect(afterSize).toBeGreaterThan(4 * 1024 * 1024);
  });

  it("preserves the most recent entries after trim", async () => {
    const oneLine = JSON.stringify(makeRecord("seed")) + "\n";
    const linesNeeded = Math.ceil((10.5 * 1024 * 1024) / oneLine.length);
    await fs.writeFile(logPath, oneLine.repeat(linesNeeded));

    await appendUsage(logPath, makeRecord("MARKER-LAST"));

    const raw = await fs.readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]!).toContain("MARKER-LAST");
    // Some seed lines should remain after trim (we keep the most recent ~5 MB).
    expect(lines[0]!).toContain("seed");
  });

  it("does not trim when file is under threshold", async () => {
    await appendUsage(logPath, makeRecord("a"));
    await appendUsage(logPath, makeRecord("b"));
    const size = (await fs.stat(logPath)).size;
    expect(size).toBeLessThan(1024);
    const raw = await fs.readFile(logPath, "utf8");
    expect(raw.trim().split("\n").length).toBe(2);
  });
});
