/**
 * Index of Claude Code session jsonl files stored in
 * `~/.claude/projects/<encoded-cwd>/*.jsonl`. The encoder matches Claude's
 * own slug rule: replace every `/` and `.` in the workspace path with `-`.
 *
 * Used by the chat-tab sidebar to list every session belonging to the
 * current workspace, regardless of which Claude tool created it
 * (Tierkit Chat, claude CLI, the VS Code extension).
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * Map a workspace path to the directory name Claude uses under
 * `~/.claude/projects/`. Verified against real on-disk samples — Claude
 * does NOT collapse repeated dashes or trim trailing dashes.
 *
 * Only absolute paths are supported; relative paths produce slugs with no
 * leading dash and will silently find nothing in Claude's on-disk layout.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

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
    try {
      const stat = await fs.stat(full);
      const { messageCount, preview } = await summarizeJsonl(full);
      if (messageCount === 0) continue;
      out.push({ id, mtime: stat.mtime.toISOString(), messageCount, preview });
    } catch (err) {
      // The file may have been deleted between readdir and stat — Claude
      // writes to its own project dir actively. Skip races; don't abort the
      // whole scan over one missing file.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
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
  let messageCount = 0;
  let preview = "";
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
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
