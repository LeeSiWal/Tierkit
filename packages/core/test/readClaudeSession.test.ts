import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readClaudeSession } from "../src/usecases/readClaudeSession.js";

async function writeJsonl(dir: string, id: string, lines: object[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
  );
}

async function makeProject(): Promise<{ home: string; cwd: string; dir: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-rcs-"));
  const cwd = "/Users/test/proj";
  const dir = path.join(home, ".claude", "projects", "-Users-test-proj");
  await fs.mkdir(dir, { recursive: true });
  return { home, cwd, dir };
}

describe("readClaudeSession", () => {
  it("parses user + assistant text messages", async () => {
    const { home, cwd, dir } = await makeProject();
    const id = "11111111-2222-3333-4444-555555555555";
    await writeJsonl(dir, id, [
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: [{ type: "text", text: "hi back" }] } },
    ]);
    const r = await readClaudeSession({ cwd, id, homeDirOverride: home });
    expect(r.id).toBe(id);
    expect(r.messages).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi back" },
    ]);
  });

  it("parses tool_use and tool_result blocks", async () => {
    const { home, cwd, dir } = await makeProject();
    const id = "22222222-2222-2222-2222-222222222222";
    await writeJsonl(dir, id, [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "tu1", name: "Read", input: { path: "x.ts" } },
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tu1", content: "file body" },
      ] } },
    ]);
    const r = await readClaudeSession({ cwd, id, homeDirOverride: home });
    expect(r.messages).toEqual([
      { role: "assistant", toolUse: { id: "tu1", name: "Read", input: { path: "x.ts" } } },
      { role: "tool", toolResultFor: "tu1", text: "file body" },
    ]);
  });

  it("returns code:not-found for a missing session file", async () => {
    const { home, cwd } = await makeProject();
    await expect(
      readClaudeSession({ cwd, id: "99999999-9999-9999-9999-999999999999", homeDirOverride: home })
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("returns code:bad-id for an id that doesn't match the UUID shape", async () => {
    const { home, cwd } = await makeProject();
    await expect(
      readClaudeSession({ cwd, id: "../etc/passwd", homeDirOverride: home })
    ).rejects.toMatchObject({ code: "bad-id" });
  });

  it("flattens a single assistant message with both text and tool_use blocks", async () => {
    const { home, cwd, dir } = await makeProject();
    const id = "44444444-4444-4444-4444-444444444444";
    await writeJsonl(dir, id, [
      { type: "assistant", message: { content: [
        { type: "text", text: "I'll read that" },
        { type: "tool_use", id: "tu2", name: "Read", input: { path: "a.ts" } },
      ] } },
    ]);
    const r = await readClaudeSession({ cwd, id, homeDirOverride: home });
    expect(r.messages).toEqual([
      { role: "assistant", text: "I'll read that" },
      { role: "assistant", toolUse: { id: "tu2", name: "Read", input: { path: "a.ts" } } },
    ]);
  });

  it("skips queue-operation, attachment, and malformed lines", async () => {
    const { home, cwd, dir } = await makeProject();
    const id = "33333333-3333-3333-3333-333333333333";
    await writeJsonl(dir, id, [
      { type: "queue-operation", operation: "enqueue" },
      { type: "attachment", content: "ignored" },
      { type: "user", message: { content: "real one" } },
    ]);
    await fs.appendFile(path.join(dir, `${id}.jsonl`), "\n{bad json\n");
    const r = await readClaudeSession({ cwd, id, homeDirOverride: home });
    expect(r.messages).toEqual([{ role: "user", text: "real one" }]);
  });
});
