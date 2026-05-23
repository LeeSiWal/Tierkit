import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attributeModelFromJsonls } from "../src/runtime/attributeModelFromJsonls.js";

async function makeFixture(): Promise<{ home: string; cwd: string; dir: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-attr-"));
  const cwd = "/Users/test/proj";
  const dir = path.join(home, ".claude", "projects", "-Users-test-proj");
  await fs.mkdir(dir, { recursive: true });
  return { home, cwd, dir };
}

async function writeJsonl(dir: string, id: string, lines: object[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
  );
}

describe("attributeModelFromJsonls", () => {
  it("maps each claude activity to the nearest preceding assistant model within 5min", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "11111111-1111-1111-1111-111111111111", [
      { type: "assistant", message: { model: "claude-sonnet-4-6" }, timestamp: "2026-05-23T10:00:00Z" },
      { type: "assistant", message: { model: "claude-opus-4-7" },   timestamp: "2026-05-23T10:05:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:30Z", clientName: "claude-code", savedTokens: 100 },
        { ts: "2026-05-23T10:05:30Z", clientName: "claude-code", savedTokens: 200 },
        { ts: "2026-05-23T10:15:00Z", clientName: "claude-code", savedTokens: 50 },
      ],
    });
    expect(r).toEqual([
      { ts: "2026-05-23T10:00:30Z", clientName: "claude-code", model: "claude-sonnet-4-6", savedTokens: 100 },
      { ts: "2026-05-23T10:05:30Z", clientName: "claude-code", model: "claude-opus-4-7",   savedTokens: 200 },
      { ts: "2026-05-23T10:15:00Z", clientName: "claude-code", model: "unknown",            savedTokens: 50 },
    ]);
  });

  it("non-claude clients always get model:unknown (no jsonl source)", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "22222222-2222-2222-2222-222222222222", [
      { type: "assistant", message: { model: "claude-opus-4-7" }, timestamp: "2026-05-23T10:00:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:30Z", clientName: "codex",   savedTokens: 100 },
        { ts: "2026-05-23T10:00:30Z", clientName: "unknown", savedTokens: 100 },
      ],
    });
    expect(r.map((a) => a.model)).toEqual(["unknown", "unknown"]);
  });

  it("empty projects dir → all attributions are 'unknown'", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-attr-empty-"));
    const r = await attributeModelFromJsonls({
      cwd: "/no/such/proj",
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:00Z", clientName: "claude-code", savedTokens: 100 },
      ],
    });
    expect(r[0]?.model).toBe("unknown");
  });

  it("ignores assistant turns AFTER the activity timestamp (only preceding count)", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "33333333-3333-3333-3333-333333333333", [
      { type: "assistant", message: { model: "claude-opus-4-7" }, timestamp: "2026-05-23T10:10:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:09:00Z", clientName: "claude-code", savedTokens: 100 },
      ],
    });
    expect(r[0]?.model).toBe("unknown");
  });

  it("scans all jsonl files in the projects dir, not just one", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", [
      { type: "assistant", message: { model: "claude-sonnet-4-6" }, timestamp: "2026-05-23T10:00:00Z" },
    ]);
    await writeJsonl(dir, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", [
      { type: "assistant", message: { model: "claude-opus-4-7" }, timestamp: "2026-05-23T11:00:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:30Z", clientName: "claude-code", savedTokens: 100 },
        { ts: "2026-05-23T11:00:30Z", clientName: "claude-code", savedTokens: 200 },
      ],
    });
    expect(r.map((a) => a.model)).toEqual(["claude-sonnet-4-6", "claude-opus-4-7"]);
  });
});
