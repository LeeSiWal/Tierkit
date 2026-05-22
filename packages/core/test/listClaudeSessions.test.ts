import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeCwdForClaudeProjects, listClaudeSessions } from "../src/usecases/listClaudeSessions.js";

describe("encodeCwdForClaudeProjects", () => {
  it("replaces / with -", () => {
    expect(encodeCwdForClaudeProjects("/Users/siwal/code/Tierkit"))
      .toBe("-Users-siwal-code-Tierkit");
  });

  it("replaces . with -", () => {
    expect(encodeCwdForClaudeProjects("/Users/siwal/code/Tierkit/.claude/worktrees/feat/v0.13/sub"))
      .toBe("-Users-siwal-code-Tierkit--claude-worktrees-feat-v0-13-sub");
  });

  it("handles trailing slash by leaving a trailing dash", () => {
    expect(encodeCwdForClaudeProjects("/Users/siwal/")).toBe("-Users-siwal-");
  });

  it("handles repeated dots and slashes", () => {
    expect(encodeCwdForClaudeProjects("/a/./b..c"))
      .toBe("-a---b--c");
  });

  it("returns empty string for empty string input", () => {
    expect(encodeCwdForClaudeProjects("")).toBe("");
  });
});

async function makeFixture(): Promise<{ home: string; cwd: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-ccs-home-"));
  // Fake workspace path — never actually accessed, only encoded.
  const cwd = "/Users/test/proj";
  const projectsDir = path.join(home, ".claude", "projects", "-Users-test-proj");
  await fs.mkdir(projectsDir, { recursive: true });

  // Real conversation jsonl
  const realId = "11111111-2222-3333-4444-555555555555";
  await fs.writeFile(
    path.join(projectsDir, `${realId}.jsonl`),
    [
      '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-05-22T01:00:00Z","sessionId":"' + realId + '"}',
      '{"type":"user","message":{"content":"hello there how is everything going"},"sessionId":"' + realId + '"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi!"}]},"sessionId":"' + realId + '"}',
    ].join("\n"),
  );

  // Queue-only file (no real conversation — should be skipped)
  const queueId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  await fs.writeFile(
    path.join(projectsDir, `${queueId}.jsonl`),
    '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-05-21T00:00:00Z"}\n',
  );

  return { home, cwd };
}

describe("listClaudeSessions", () => {
  it("returns one entry per non-empty jsonl, skipping queue-only files", async () => {
    const { home, cwd } = await makeFixture();
    const r = await listClaudeSessions({ cwd, homeDirOverride: home });
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]?.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(r.sessions[0]?.messageCount).toBe(2);
    expect(r.sessions[0]?.preview).toContain("hello there");
    expect(typeof r.sessions[0]?.mtime).toBe("string");
  });

  it("returns empty list when projects dir doesn't exist", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-ccs-empty-"));
    const r = await listClaudeSessions({ cwd: "/nope", homeDirOverride: home });
    expect(r.sessions).toEqual([]);
  });

  it("sorts by mtime descending", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-ccs-sort-"));
    const projectsDir = path.join(home, ".claude", "projects", "-x");
    await fs.mkdir(projectsDir, { recursive: true });
    const older = "11111111-1111-1111-1111-111111111111";
    const newer = "22222222-2222-2222-2222-222222222222";
    await fs.writeFile(
      path.join(projectsDir, `${older}.jsonl`),
      '{"type":"user","message":{"content":"first"}}\n',
    );
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(
      path.join(projectsDir, `${newer}.jsonl`),
      '{"type":"user","message":{"content":"second"}}\n',
    );
    const r = await listClaudeSessions({ cwd: "/x", homeDirOverride: home });
    expect(r.sessions.map((s) => s.id)).toEqual([newer, older]);
  });

  it("ignores malformed jsonl lines but still counts surrounding valid ones", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-ccs-bad-"));
    const projectsDir = path.join(home, ".claude", "projects", "-y");
    await fs.mkdir(projectsDir, { recursive: true });
    const id = "33333333-3333-3333-3333-333333333333";
    await fs.writeFile(
      path.join(projectsDir, `${id}.jsonl`),
      [
        '{"type":"user","message":{"content":"good one"}}',
        'this is not json',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
      ].join("\n"),
    );
    const r = await listClaudeSessions({ cwd: "/y", homeDirOverride: home });
    expect(r.sessions[0]?.messageCount).toBe(2);
  });
});
