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
    const b = block as {
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ role, text: b.text });
    } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      out.push({ role: "assistant", toolUse: { id: b.id, name: b.name, input: b.input } });
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const textContent =
        typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? b.content
                .filter(
                  (c: unknown) =>
                    c && typeof c === "object" && (c as { type?: string }).type === "text",
                )
                .map((c: { text?: string }) => c.text || "")
                .join("\n")
            : "";
      out.push({ role: "tool", toolResultFor: b.tool_use_id, text: textContent });
    }
  }
  return out;
}
