# Chat Sessions in Chat Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Chat Sessions card from Settings into a collapsible left sidebar inside the Chat tab. Clicking a session loads its history from Claude's own jsonl store and continues the conversation via `claude --resume`.

**Architecture:** Two new daemon endpoints expose Claude's per-project session jsonl files (`~/.claude/projects/<encoded-cwd>/*.jsonl`) — one for the index, one for the full message thread. The chat tab GUI gains a left sidebar that renders the index, and clicking a row swaps the agent-thread DOM contents with bubbles synthesized from the message thread, then sets `tkChatSessionId` so the next message continues that session.

**Tech Stack:** TypeScript + Node `fs/promises` + `readline` (line-streamed jsonl) on the daemon. Vanilla JS DOM + CSS flex layout for the GUI. Vitest for daemon tests.

Spec: [`docs/superpowers/specs/2026-05-22-chat-sessions-in-chat-tab-design.md`](../specs/2026-05-22-chat-sessions-in-chat-tab-design.md)

---

## File Structure

**New files:**
- `packages/core/src/usecases/listClaudeSessions.ts` — pure usecase: scan `~/.claude/projects/<encoded>/*.jsonl`, build index. Imported by Server.ts route + tested in isolation.
- `packages/core/src/usecases/readClaudeSession.ts` — pure usecase: parse one jsonl file into `[{ role, text?, toolUse?, toolResultFor? }]`. Imported by Server.ts route + tested in isolation.
- `packages/core/test/listClaudeSessions.test.ts` — unit tests using a tmp `.claude/projects` fixture.
- `packages/core/test/readClaudeSession.test.ts` — unit tests for the jsonl parser.

**Modified files:**
- `packages/core/src/runtime/Server.ts` — wire the two new routes; about ~50 lines added.
- `packages/core/src/runtime/ui/gui.ts` — sidebar HTML + CSS, three new functions (`loadChatSessions`, `loadChatSessionMessages`, `newChatSession`), remove the Settings-tab Chat-sessions card, rewire `recordSessionEvent` to also refresh the sidebar.

Each usecase file is ~80 lines max, focused on one operation, with no dependencies on Server.ts. The Server.ts route handlers stay thin (validate input → call usecase → sendJson).

---

## Task 1: encodeCwd helper + tests

**Files:**
- Create: `packages/core/src/usecases/listClaudeSessions.ts`
- Test: `packages/core/test/listClaudeSessions.test.ts`

Claude encodes the workspace path into a directory name by replacing every `/` and `.` with `-`. We need that encoder before anything else.

- [ ] **Step 1: Write the failing test for encodeCwd**

Create `packages/core/test/listClaudeSessions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeCwdForClaudeProjects } from "../src/usecases/listClaudeSessions.js";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test listClaudeSessions`
Expected: FAIL — module not found / `encodeCwdForClaudeProjects` not exported.

- [ ] **Step 3: Create the usecase file with the encoder**

Create `packages/core/src/usecases/listClaudeSessions.ts`:

```ts
/**
 * Index of Claude Code session jsonl files stored in
 * `~/.claude/projects/<encoded-cwd>/*.jsonl`. The encoder matches Claude's
 * own slug rule: replace every `/` and `.` in the workspace path with `-`.
 *
 * Used by the chat-tab sidebar to list every session belonging to the
 * current workspace, regardless of which Claude tool created it
 * (Tierkit Chat, claude CLI, the VS Code extension).
 */

/**
 * Map a workspace path to the directory name Claude uses under
 * `~/.claude/projects/`. Verified against real on-disk samples — Claude
 * does NOT collapse repeated dashes or trim trailing dashes.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tierkit/core test listClaudeSessions`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/usecases/listClaudeSessions.ts packages/core/test/listClaudeSessions.test.ts
git -c commit.gpgsign=false commit -m "feat(core): encodeCwdForClaudeProjects helper for session paths

Maps a workspace path to Claude's ~/.claude/projects/ directory slug by
replacing every / and . with -. Verified against on-disk samples.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: listClaudeSessions usecase + tests

**Files:**
- Modify: `packages/core/src/usecases/listClaudeSessions.ts` (add the main function)
- Modify: `packages/core/test/listClaudeSessions.test.ts` (add scan tests)

- [ ] **Step 1: Add failing tests for the scan function**

Append to `packages/core/test/listClaudeSessions.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listClaudeSessions } from "../src/usecases/listClaudeSessions.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tierkit/core test listClaudeSessions`
Expected: FAIL — `listClaudeSessions` not exported.

- [ ] **Step 3: Implement listClaudeSessions**

Append to `packages/core/src/usecases/listClaudeSessions.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ClaudeSessionSummary {
  id: string;
  /** mtime ISO string. */
  mtime: string;
  /** Count of user + assistant messages. */
  messageCount: number;
  /** First user message, single-line, truncated to 120 chars. Empty when none. */
  preview: string;
}

export interface ListClaudeSessionsInput {
  cwd: string;
  /** Override $HOME for tests. */
  homeDirOverride?: string;
}

export interface ListClaudeSessionsOutput {
  sessions: ClaudeSessionSummary[];
}

/**
 * Scan `~/.claude/projects/<encoded-cwd>/*.jsonl` and return one summary per
 * file. Files with no `user`/`assistant` events (e.g. queue-operation-only)
 * are skipped — they aren't real conversations. Sorted by mtime descending.
 */
export async function listClaudeSessions(
  input: ListClaudeSessionsInput,
): Promise<ListClaudeSessionsOutput> {
  const home = input.homeDirOverride ?? os.homedir();
  const dir = path.join(home, ".claude", "projects", encodeCwdForClaudeProjects(input.cwd));

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [] };
    throw err;
  }

  const out: ClaudeSessionSummary[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const id = ent.name.slice(0, -".jsonl".length);
    const full = path.join(dir, ent.name);
    const stat = await fs.stat(full);
    const { messageCount, preview } = await summarizeJsonl(full);
    if (messageCount === 0) continue;
    out.push({ id, mtime: stat.mtime.toISOString(), messageCount, preview });
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
  return { sessions: out };
}

/**
 * Walk a jsonl file line by line, count user+assistant messages, capture the
 * first user message content as a one-line preview. Malformed lines and
 * unknown event types are silently skipped — Claude has many internal event
 * types we don't care about and forward-compatibility is more important than
 * loud failure.
 */
async function summarizeJsonl(filePath: string): Promise<{ messageCount: number; preview: string }> {
  const text = await fs.readFile(filePath, "utf8");
  let messageCount = 0;
  let preview = "";
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event: { type?: string; message?: { content?: unknown } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "user" && event.type !== "assistant") continue;
    messageCount += 1;
    if (preview === "" && event.type === "user") {
      preview = extractPreviewText(event.message?.content).slice(0, 120);
    }
  }
  return { messageCount, preview };
}

/**
 * Claude messages can have content as a plain string OR an array of blocks
 * (text, tool_use, tool_result). Pull the first text-y piece, collapse
 * whitespace.
 */
function extractPreviewText(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: string }).text;
        if (typeof t === "string") return t.replace(/\s+/g, " ").trim();
      }
    }
  }
  return "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core test listClaudeSessions`
Expected: PASS, 7 tests (3 from Task 1 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/usecases/listClaudeSessions.ts packages/core/test/listClaudeSessions.test.ts
git -c commit.gpgsign=false commit -m "feat(core): listClaudeSessions usecase

Scans ~/.claude/projects/<encoded-cwd>/*.jsonl and returns one summary per
non-empty session file. Sorted by mtime desc. Empty-projects-dir → empty
list (not error). Malformed lines skipped silently for forward compat.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: readClaudeSession usecase + tests

**Files:**
- Create: `packages/core/src/usecases/readClaudeSession.ts`
- Test: `packages/core/test/readClaudeSession.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/test/readClaudeSession.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tierkit/core test readClaudeSession`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement readClaudeSession**

Create `packages/core/src/usecases/readClaudeSession.ts`:

```ts
/**
 * Parse one Claude Code session jsonl file into a typed message array the
 * GUI can render as chat bubbles. We mirror the live chat thread's event
 * vocabulary so the same renderers work for both live + historical views.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeCwdForClaudeProjects } from "./listClaudeSessions.js";

export interface ClaudeSessionMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
  toolResultFor?: string;
}

export interface ReadClaudeSessionInput {
  cwd: string;
  id: string;
  homeDirOverride?: string;
}

export interface ReadClaudeSessionOutput {
  id: string;
  messages: ClaudeSessionMessage[];
}

export class ReadClaudeSessionError extends Error {
  constructor(public code: "bad-id" | "not-found", message: string) {
    super(message);
    this.name = "ReadClaudeSessionError";
  }
}

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function readClaudeSession(
  input: ReadClaudeSessionInput,
): Promise<ReadClaudeSessionOutput> {
  if (!UUID_RE.test(input.id)) {
    throw new ReadClaudeSessionError("bad-id", `invalid session id: ${input.id}`);
  }
  const home = input.homeDirOverride ?? os.homedir();
  const file = path.join(
    home,
    ".claude",
    "projects",
    encodeCwdForClaudeProjects(input.cwd),
    `${input.id}.jsonl`,
  );

  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReadClaudeSessionError("not-found", `session ${input.id} not found`);
    }
    throw err;
  }

  const messages: ClaudeSessionMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event: { type?: string; message?: { content?: unknown } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "user" || event.type === "assistant") {
      messages.push(...extractFromMessage(event.type, event.message?.content));
    }
    // queue-operation, attachment, summary, unknown types are silently dropped
  }
  return { id: input.id, messages };
}

/**
 * One jsonl event can produce multiple ClaudeSessionMessage entries when the
 * content is an array (e.g. assistant text + tool_use blocks in the same
 * message). We flatten so the GUI gets a linear stream it can render top-to-
 * bottom without nested branching.
 */
function extractFromMessage(
  role: "user" | "assistant",
  content: unknown,
): ClaudeSessionMessage[] {
  if (typeof content === "string") {
    return [{ role, text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: ClaudeSessionMessage[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ role, text: b.text });
    } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      out.push({ role: "assistant", toolUse: { id: b.id, name: b.name, input: b.input } });
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const textContent = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content
              .filter((c: unknown) => c && typeof c === "object" && (c as { type?: string }).type === "text")
              .map((c: { text?: string }) => c.text || "")
              .join("\n")
          : "";
      out.push({ role: "tool", toolResultFor: b.tool_use_id, text: textContent });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core test readClaudeSession`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/usecases/readClaudeSession.ts packages/core/test/readClaudeSession.test.ts
git -c commit.gpgsign=false commit -m "feat(core): readClaudeSession usecase

Parses one ~/.claude/projects/<encoded>/<id>.jsonl into a flat
[{ role, text?, toolUse?, toolResultFor? }] array. Throws typed
ReadClaudeSessionError for bad-id (path traversal guard) and not-found.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Wire the two daemon routes

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` (add ~50 lines around line 480, near other claude-code routes)

- [ ] **Step 1: Add the two new imports at the top of Server.ts**

Find the existing chatWithClaude import (around line 30) and add right below:

```ts
import { listClaudeSessions } from "../usecases/listClaudeSessions.js";
import { readClaudeSession, ReadClaudeSessionError } from "../usecases/readClaudeSession.js";
```

- [ ] **Step 2: Add the GET /v1/claude-code/sessions route**

Find the existing `if (route === "POST /v1/claude-code/chat")` block in Server.ts (around line 483). Insert immediately before it:

```ts
      if (route === "GET /v1/claude-code/sessions") {
        try {
          const r = await listClaudeSessions({ cwd: opts.cwd });
          return sendJson(res, 200, { ok: true, sessions: r.sessions });
        } catch (err) {
          return sendJson(res, 500, { ok: false, code: "scan-failed", message: (err as Error).message });
        }
      }

      if (method === "GET" && url.pathname.startsWith("/v1/claude-code/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/claude-code/sessions/".length));
        try {
          const r = await readClaudeSession({ cwd: opts.cwd, id });
          return sendJson(res, 200, { ok: true, id: r.id, messages: r.messages });
        } catch (err) {
          if (err instanceof ReadClaudeSessionError) {
            const status = err.code === "bad-id" ? 400 : 404;
            return sendJson(res, status, { ok: false, code: err.code, message: err.message });
          }
          return sendJson(res, 500, { ok: false, code: "read-failed", message: (err as Error).message });
        }
      }
```

- [ ] **Step 3: Write an integration test for both routes**

Create `packages/core/test/claudeCodeSessions.routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/index.js";

describe("GET /v1/claude-code/sessions[/:id]", () => {
  let server: RunningServer;
  let home: string;
  let workspace: string;
  let baseUrl: string;
  const realId = "11111111-2222-3333-4444-555555555555";

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-srv-ccs-"));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tk-srv-ccs-ws-"));
    process.env.HOME = home; // listClaudeSessions reads os.homedir() by default
    const dir = path.join(home, ".claude", "projects", workspace.replace(/[/.]/g, "-"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${realId}.jsonl`),
      [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      ].join("\n"),
    );
    server = await startServer({ cwd: workspace, host: "127.0.0.1", port: 0, adapters: {} });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => { await server.close(); });

  it("GET /sessions returns the seeded session", async () => {
    const r = await fetch(`${baseUrl}/v1/claude-code/sessions`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.sessions[0]?.id).toBe(realId);
  });

  it("GET /sessions/:id returns the parsed message thread", async () => {
    const r = await fetch(`${baseUrl}/v1/claude-code/sessions/${realId}`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  it("GET /sessions/:id returns 404 for missing session", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/99999999-9999-9999-9999-999999999999`);
    expect(res.status).toBe(404);
  });

  it("GET /sessions/:id returns 400 for malformed id", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it("GET /sessions/:id rejects path traversal", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/${encodeURIComponent("../etc/passwd")}`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @tierkit/core test claudeCodeSessions.routes`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `pnpm --filter @tierkit/core test`
Expected: All tests pass (will include existing ~872 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/Server.ts packages/core/test/claudeCodeSessions.routes.test.ts
git -c commit.gpgsign=false commit -m "feat(http): GET /v1/claude-code/sessions[/:id] for chat-tab sidebar

New endpoints back the chat-tab sidebar: list every Claude session for the
current workspace, and load one session's messages on click. Path-traversal
guarded via UUID regex; missing session returns 404.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Add chat-tab sidebar HTML + CSS

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts` (HTML around line 746, CSS in the `<style>` block)

- [ ] **Step 1: Wrap the chat-tab panel content in a flex layout**

Find in `gui.ts` (around line 746):

```html
<div class="tab-panel active" data-tab-panel="chat">
<div id="host-banner" class="err-banner" style="display:none"></div>

<div class="agent-shell">
```

Replace with:

```html
<div class="tab-panel active" data-tab-panel="chat">
<div id="host-banner" class="err-banner" style="display:none"></div>

<div class="chat-layout">
  <aside id="tk-chat-sidebar" class="chat-sidebar">
    <div class="chat-sidebar-header">
      <button id="tk-chat-sidebar-toggle" class="tiny" title="toggle">«</button>
      <button id="tk-chat-new-session" class="tiny primary" title="start a new session">+ <span data-i18n="chatNewSession">New</span></button>
    </div>
    <div id="tk-chat-session-list">
      <div class="empty dim" data-i18n="loading">loading…</div>
    </div>
  </aside>

<div class="agent-shell">
```

Find the closing `</div><!-- /tab-panel:chat -->` (around line 833). Add one extra closing div above it for the new `chat-layout`:

```html
</div><!-- /agent-shell (existing) -->
</div><!-- /chat-layout (new) -->
</div><!-- /tab-panel:chat -->
```

(Adjust the existing closing tags so they balance — count `<div>` opens vs closes inside the chat panel.)

- [ ] **Step 2: Add CSS rules for the sidebar**

Find the CSS block `.tab-panel.active[data-tab-panel="chat"]` (around line 564). Add immediately after that rule:

```css
  /* Chat tab: split into sidebar + main thread. The sidebar lists past sessions
     and is collapsible to keep the chat thread roomy. */
  .chat-layout {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .chat-sidebar {
    flex: 0 0 220px;
    min-width: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-card);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .chat-sidebar.collapsed { flex-basis: 36px; }
  .chat-sidebar.collapsed .chat-sidebar-header > #tk-chat-new-session,
  .chat-sidebar.collapsed #tk-chat-session-list { display: none; }
  .chat-sidebar-header {
    display: flex;
    gap: 4px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .chat-sidebar-header > button { flex: 0 0 auto; }
  .chat-sidebar-header > #tk-chat-new-session { flex: 1 1 auto; min-width: 0; }
  #tk-chat-session-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px;
  }
  .chat-session-row {
    padding: 6px 8px;
    margin-bottom: 2px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .chat-session-row:hover { background: var(--bg-hover); }
  .chat-session-row.selected { background: var(--bg-hover); border-left: 2px solid var(--accent); padding-left: 6px; }
  .chat-session-row .session-preview { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-session-row .session-meta { color: var(--fg-dim); font-family: var(--mono); font-size: 10px; }
  /* On narrow viewports, the sidebar auto-collapses so the thread isn't squeezed. */
  @media (max-width: 480px) {
    .chat-sidebar { flex-basis: 36px; }
    .chat-sidebar > #tk-chat-new-session,
    .chat-sidebar #tk-chat-session-list { display: none; }
  }
```

- [ ] **Step 3: Update existing `.agent-shell` rule so it shares the flex row**

Find:

```css
  .agent-shell {
    max-width: 880px;
    width: 100%;
    margin: 14px auto 0;
```

Change to:

```css
  .agent-shell {
    max-width: 880px;
    width: 100%;
    margin: 14px auto 0;
    flex: 1;
    min-width: 0;
```

(`flex: 1; min-width: 0` lets it claim the remaining row width inside `.chat-layout` while still respecting its own max-width centering.)

- [ ] **Step 4: Add the i18n entries**

Find the `ko` and `en` LOCALES objects in gui.ts (around line 1160 and 1280). Add `chatNewSession` to each:

```js
// in en
chatNewSession: 'New',
// in ko
chatNewSession: '새 세션',
```

- [ ] **Step 5: Verify the GUI tests still pass (snapshot may need update)**

Run: `pnpm --filter @tierkit/core test guiHtml`
Expected: PASS, or a snapshot mismatch you accept once you've eyeballed the new HTML.

If a snapshot fails, look at the diff — if it matches the planned HTML change, update with `pnpm --filter @tierkit/core test guiHtml -u`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts packages/core/test/guiHtml.test.ts
git -c commit.gpgsign=false commit -m "feat(ui): chat-tab left sidebar HTML + CSS scaffolding

Wraps agent-shell in a flex .chat-layout with a collapsible 220px aside.
JS handlers wired in next commit. Auto-collapses below 480px width.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Wire sidebar JS — loadChatSessions

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts` (JS section near refreshSessionsCard, around line 4750)

- [ ] **Step 1: Add the loadChatSessions function**

Find the existing `refreshSessionsCard` function (around line 4750 in gui.ts) and add immediately above it:

```js
  /**
   * v0.22: chat-tab sidebar. Fetches the session index from the daemon and
   * joins on the localStorage metrics map so each row shows id, preview,
   * mtime, and (if we've seen it before in Tierkit Chat) token + cost stats.
   * Highlights tkChatSessionId so the user always sees which session the
   * active thread belongs to.
   */
  async function loadChatSessions() {
    const host = $('tk-chat-session-list');
    if (!host) return;
    let sessions;
    try {
      const r = await jget('/v1/claude-code/sessions');
      sessions = r.sessions || [];
    } catch (e) {
      host.innerHTML = '<div class="empty dim">' + escapeHtml(lang === 'ko' ? '세션 불러오기 실패' : 'Failed to load sessions') +
        ' · <button class="tiny" id="tk-chat-sessions-retry">' + escapeHtml(lang === 'ko' ? '재시도' : 'Retry') + '</button></div>';
      const retry = $('tk-chat-sessions-retry');
      if (retry) retry.onclick = () => loadChatSessions();
      return;
    }
    if (sessions.length === 0) {
      host.innerHTML = '<div class="empty dim">' + escapeHtml(lang === 'ko' ? '아직 채팅 세션 없음' : 'No chat sessions yet') + '</div>';
      return;
    }
    const meta = loadSessions(); // existing helper for tk_chat_sessions localStorage
    host.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'chat-session-row';
      if (s.id === tkChatSessionId) row.classList.add('selected');
      row.dataset.sessionId = s.id;
      const m = meta[s.id];
      const tokens = m ? ((m.tokensIn || 0) + (m.tokensOut || 0)) : 0;
      const cost = m ? (m.costUsd || 0) : 0;
      const tokensShort = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
      const when = (() => {
        try {
          const d = new Date(s.mtime);
          return d.toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch { return ''; }
      })();
      row.innerHTML =
        '<div class="session-preview">' + escapeHtml(s.preview || s.id.slice(0, 8) + '…') + '</div>' +
        '<div class="session-meta">' + escapeHtml(s.id.slice(0, 8)) + ' · ' + escapeHtml(when) + ' · ' + s.messageCount + ' msg' +
        (tokens ? ' · ' + tokensShort + ' tok' : '') +
        (cost > 0 ? ' · $' + cost.toFixed(4) : '') +
        '</div>';
      row.onclick = () => loadChatSessionMessages(s.id);
      host.appendChild(row);
    }
  }
```

- [ ] **Step 2: Add the sidebar toggle handler at init time**

Find the line where the chat tab is set up. Search for `tk-chat-sidebar-toggle`. It won't exist yet — add a wire-up block near other chat-input event listeners (search for `agent-input.addEventListener` to find the section). Add:

```js
  // ── Chat sidebar toggle + new-session button ─────────────────────────────
  const TK_SIDEBAR_LS_KEY = 'tk_chat_sidebar_collapsed';
  const sidebarEl = $('tk-chat-sidebar');
  const sidebarToggleBtn = $('tk-chat-sidebar-toggle');
  if (sidebarEl && sidebarToggleBtn) {
    if (localStorage.getItem(TK_SIDEBAR_LS_KEY) === '1') {
      sidebarEl.classList.add('collapsed');
      sidebarToggleBtn.textContent = '»';
    }
    sidebarToggleBtn.onclick = () => {
      const collapsed = sidebarEl.classList.toggle('collapsed');
      sidebarToggleBtn.textContent = collapsed ? '»' : '«';
      try { localStorage.setItem(TK_SIDEBAR_LS_KEY, collapsed ? '1' : '0'); } catch { /* quota */ }
    };
  }
  const newSessionBtn = $('tk-chat-new-session');
  if (newSessionBtn) {
    newSessionBtn.onclick = () => newChatSession();
  }
```

- [ ] **Step 3: Add newChatSession (resets thread + sessionId)**

Right after the wire-up block above, add the function:

```js
  function newChatSession() {
    tkChatSessionId = null;
    const thread = $('agent-thread');
    if (thread) {
      thread.innerHTML = '';
      // Restore the original empty placeholder (matches the static HTML's <div class="agent-empty"> child).
      const empty = document.createElement('div');
      empty.className = 'agent-empty';
      empty.style.lineHeight = '1.6';
      empty.innerHTML = (i18n.agentEmpty || '');
      thread.appendChild(empty);
    }
    loadChatSessions();
  }
```

- [ ] **Step 4: Call loadChatSessions when the chat tab activates**

Find `setActiveTab` (around line 1730). At the end of the function body (after the existing logic that toggles `.active` classes), add:

```js
    if (name === 'chat') loadChatSessions();
```

- [ ] **Step 5: Hook recordSessionEvent to refresh the sidebar**

Find `recordSessionEvent` (around line 4717). At the end of the function (after `saveSessions(map);`), replace:

```js
    saveSessions(map);
    refreshSessionsCard();
  }
```

With:

```js
    saveSessions(map);
    loadChatSessions();
  }
```

(refreshSessionsCard goes away with the Settings card in Task 7.)

- [ ] **Step 6: Run the GUI tests and snapshot update**

Run: `pnpm --filter @tierkit/core test guiHtml`
Expected: PASS (with snapshot updates if necessary — `-u` after eyeball review).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts packages/core/test/guiHtml.test.ts
git -c commit.gpgsign=false commit -m "feat(ui): wire chat-tab sidebar — loadChatSessions, toggle, +New

Sidebar populates on chat-tab activation and after every recordSessionEvent.
Toggle state persists in localStorage. + New clears the thread and resets
tkChatSessionId so the next message starts a fresh claude session.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: loadChatSessionMessages — restore a session into the thread

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts` (after loadChatSessions)

- [ ] **Step 1: Add loadChatSessionMessages**

Right after `loadChatSessions` (and `newChatSession`), add:

```js
  /**
   * Click a session row → fetch its message thread → render into agent-thread
   * using the same bubble factories the live chat uses. Sets tkChatSessionId
   * so the next composer send continues that session via claude --resume.
   */
  async function loadChatSessionMessages(id) {
    let data;
    try {
      data = await jget('/v1/claude-code/sessions/' + encodeURIComponent(id));
    } catch (e) {
      // jget throws on non-2xx. Map 404 to a friendly "session vanished" toast.
      const msg = /HTTP 404/.test(String(e.message)) || /not-found/.test(String(e.message))
        ? (lang === 'ko' ? '이 세션은 사라졌습니다 — 다른 세션을 선택해주세요' : 'Session no longer exists — pick another')
        : String(e.message);
      toast(msg, 'err');
      loadChatSessions(); // sync the sidebar with reality
      return;
    }

    tkChatSessionId = id;
    const thread = $('agent-thread');
    if (!thread) return;
    thread.innerHTML = '';

    // Walk messages and synthesize bubbles. We reuse the live chat factories
    // so historical view and in-flight view look the same.
    let currentAssistantBubble = null;
    for (const m of (data.messages || [])) {
      if (m.role === 'user') {
        currentAssistantBubble = null;
        appendUserBubble(m.text || '');
      } else if (m.role === 'assistant') {
        if (m.text) {
          if (!currentAssistantBubble) currentAssistantBubble = chatAssistantBubble();
          currentAssistantBubble.appendText(m.text);
        } else if (m.toolUse) {
          if (!currentAssistantBubble) currentAssistantBubble = chatAssistantBubble();
          currentAssistantBubble.addToolUse(m.toolUse);
        }
      } else if (m.role === 'tool') {
        if (currentAssistantBubble) {
          currentAssistantBubble.addToolResult({ toolUseId: m.toolResultFor, output: m.text, isError: false });
        }
      }
    }
    if (currentAssistantBubble) currentAssistantBubble.finalize({});
    loadChatSessions(); // refresh highlight
  }
```

- [ ] **Step 2: Add appendUserBubble helper if not present**

Search gui.ts for `appendUserBubble`. If not found, add right above loadChatSessionMessages:

```js
  function appendUserBubble(text) {
    const thread = $('agent-thread');
    if (!thread) return;
    const bubble = document.createElement('div');
    bubble.className = 'msg user';
    bubble.style.cssText = 'margin:6px 0;padding:6px 10px;background:rgba(122,162,247,0.08);border-radius:4px;font-size:12px;white-space:pre-wrap;word-wrap:break-word';
    bubble.textContent = text;
    thread.appendChild(bubble);
  }
```

(If a similar helper exists under another name like `addUserMessage` or `userBubble`, use that instead — keep one source of truth for user-bubble rendering.)

- [ ] **Step 3: Smoke-test in the dev build**

Run: `pnpm --filter @tierkit/core build && cd packages/vscode-tierkit && pnpm run build && pnpm run package:sideload`
Then hot-deploy the dist to live daemon (same pattern used during hotfixes):

```bash
EXT_DIR=/Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12
VSIX=/Users/siwal/code/Tierkit/packages/vscode-tierkit/tierkit-vscode-0.21.12.vsix
TMP=$(mktemp -d) && unzip -q "$VSIX" -d "$TMP"
cp "$TMP/extension/dist/extension.js" "$EXT_DIR/dist/extension.js"
rm -rf "$TMP"
```

Reload the code-server window and verify:
- Chat tab shows a left sidebar
- Sidebar lists sessions for this workspace (should include any past Tierkit Chat sessions + any claude-vscode sessions)
- Clicking a row replaces the thread with that session's history
- Typing a new message continues that session

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "feat(ui): loadChatSessionMessages restores session into chat thread

Click a sidebar row → daemon returns messages → bubbles synthesized with
existing factories → tkChatSessionId updated. Next composer send continues
the session via claude --resume.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Remove the old Chat Sessions card from Settings

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts` (around lines 977–984)

- [ ] **Step 1: Delete the old Settings card**

Find in gui.ts:

```html
  <!-- v0.21.10: per-session metrics. Each chat thread (Claude session_id) gets
       its own row so the user can see usage broken down by conversation. -->
  <section class="card">
    <h2><span data-i18n="cardChatSessions">Chat sessions</span></h2>
    <div class="dim" style="font-size:10.5px;margin-bottom:8px" data-i18n="hintChatSessions">Each chat thread (Claude session) tracked separately. Stored locally in your browser; clears on full reset.</div>
    <div id="tk-sessions-list"></div>
    <div style="margin-top:8px;text-align:right">
      <button id="tk-sessions-clear" class="tiny" data-i18n="sessionsClear">Clear history</button>
    </div>
  </section>
```

Delete this entire section (including the comment block).

- [ ] **Step 2: Remove the now-dead refreshSessionsCard function and its Clear-history wire-up**

Search gui.ts for `refreshSessionsCard`. Delete the entire function definition.

Search for `tkSessionsClearBtn` (around line 4790). Delete the wire-up block:

```js
  const tkSessionsClearBtn = $('tk-sessions-clear');
  if (tkSessionsClearBtn) {
    tkSessionsClearBtn.onclick = () => {
      try { localStorage.removeItem(TK_SESSIONS_LS_KEY); } catch (_) { /* */ }
      // ... rest of the handler
    };
  }
```

(Delete the whole `if` block but keep `TK_SESSIONS_LS_KEY` itself — `recordSessionEvent` still uses it for the localStorage metrics that hang off the sidebar rows.)

- [ ] **Step 3: Remove dead i18n entries**

Search for `cardChatSessions`, `hintChatSessions`, `sessionsClear` in the i18n LOCALES objects. Delete those keys from both `en` and `ko` locales.

- [ ] **Step 4: Verify nothing else references the removed identifiers**

Run: `grep -nE "tk-sessions-list|tk-sessions-clear|refreshSessionsCard|cardChatSessions|hintChatSessions|sessionsClear" packages/core/src/runtime/ui/gui.ts`
Expected: no output (all references removed).

- [ ] **Step 5: Run all tests + build to confirm cleanliness**

Run: `pnpm --filter @tierkit/core test && pnpm --filter @tierkit/core build`
Expected: all tests pass, clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "refactor(ui): remove the old Chat Sessions card from Settings

The data lives in the new chat-tab sidebar now. refreshSessionsCard and the
Clear-history button are gone — clearing localStorage metadata wouldn't
delete Claude's jsonl files anyway, so the button was misleading. Users
who want to wipe history delete the jsonl files themselves.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Build vsix + deploy + verify

**Files:** (none — packaging only)

- [ ] **Step 1: Build core + extension**

Run: `pnpm --filter @tierkit/core build && cd packages/vscode-tierkit && pnpm run build`
Expected: clean build, no TS errors.

- [ ] **Step 2: Package vsix**

Run: `cd packages/vscode-tierkit && pnpm run package:sideload`
Expected: `tierkit-vscode-0.21.12.vsix` produced (~1.22 MB).

- [ ] **Step 3: Hot-deploy to live daemon**

Run:

```bash
EXT_DIR=/Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12
VSIX=/Users/siwal/code/Tierkit/packages/vscode-tierkit/tierkit-vscode-0.21.12.vsix
TMP=$(mktemp -d) && unzip -q "$VSIX" -d "$TMP"
cp "$TMP/extension/dist/extension.js" "$EXT_DIR/dist/extension.js"
cp "$TMP/extension/dist/extension.js.map" "$EXT_DIR/dist/extension.js.map" 2>/dev/null
rm -rf "$TMP"
echo "deployed at $(stat -f '%Sm' -t '%H:%M:%S' $EXT_DIR/dist/extension.js)"
```

- [ ] **Step 4: Reload the code-server window manually**

In code-server: `Cmd/Ctrl+Shift+P` → `Developer: Reload Window`.

- [ ] **Step 5: Manual smoke test**

Verify in the running Tierkit:
- Chat tab has a left sidebar with «-toggle + +New buttons
- Sidebar lists sessions for the current workspace (mix of Tierkit Chat + any prior claude usages)
- Click a session: thread shows that history, sidebar row highlighted
- Type a message: claude continues from that session (next user bubble appears, assistant streams)
- Click +New: thread clears, sidebar deselects, next message starts a fresh session
- Settings tab no longer has a Chat Sessions card

- [ ] **Step 6: Final commit (no code changes — just the working build artifact)**

The build outputs are gitignored; no commit needed for the .vsix itself. If the build produced incidental changes to dist (which are gitignored), there's nothing to commit. Just verify with `git status` that the working tree is clean.

---

## Self-Review

**Spec coverage:**
- New endpoints `GET /v1/claude-code/sessions` + `GET /v1/claude-code/sessions/:id` → Tasks 2, 3, 4 ✓
- Path encoding rule (slash + dot → dash) → Task 1 ✓
- Skip queue-only files in index → Task 2 (`messageCount === 0` filter) ✓
- 400 on malformed UUID, 404 on missing file → Task 3 (errors) + Task 4 (route) ✓
- Path traversal guard → Task 3 UUID regex ✓
- Sidebar HTML + CSS (220px expanded / 36px collapsed) → Task 5 ✓
- Toggle persists via localStorage → Task 6 (TK_SIDEBAR_LS_KEY) ✓
- Auto-collapse < 480px → Task 5 media query ✓
- `loadChatSessions`, `loadChatSessionMessages`, `newChatSession` → Tasks 6, 7 ✓
- recordSessionEvent rewired to refresh sidebar → Task 6 step 5 ✓
- setActiveTab('chat') triggers loadChatSessions → Task 6 step 4 ✓
- Remove old Settings card → Task 8 ✓
- Tests for daemon endpoints → Tasks 2, 3, 4 ✓
- Error handling table (sidebar retry, toast on 404, skip malformed lines) → Tasks 3, 6, 7 ✓

**Placeholder scan:** No TBDs / TODOs / "appropriate error handling" / "similar to Task N" references. Each task's code is complete.

**Type consistency:** `ClaudeSessionSummary` (Task 2), `ClaudeSessionMessage` (Task 3), endpoint response shapes (Task 4) all line up with what the GUI reads in Tasks 6, 7. The `appendUserBubble` helper used in Task 7 is defined in Task 7. The `loadSessions()` localStorage helper referenced in Task 6 is the existing function (predates this plan — no new task needed).

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-chat-sessions-in-chat-tab.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
