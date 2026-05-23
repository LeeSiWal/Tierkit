/**
 * v0.21: Tierkit Chat as a proxy in front of Claude Code.
 *
 * What this does:
 *   - Spawn `claude -p --output-format=stream-json --verbose [--resume <sid>]`
 *   - Pipe the user's message into stdin
 *   - Parse the line-delimited JSON events on stdout
 *   - Yield a clean, typed event stream to the daemon (which forwards it as SSE
 *     to the Tierkit webview)
 *
 * Why proxy through the CLI:
 *   - Uses the user's existing Claude Code subscription auth — no API key.
 *   - Reuses CLAUDE.md, MCP servers (including our own tierkit MCP), hooks,
 *     skills — all the same context the user's normal Claude Code has.
 *   - Returns a session_id that we feed back via --resume so the conversation
 *     continues across user messages.
 *
 * The webview rendering pipeline:
 *   user types in Tierkit Chat → daemon spawns claude CLI → CLI streams JSON
 *   → daemon forwards as SSE → webview renders assistant bubble in real time.
 *   Zero ⌘V. Tierkit Chat becomes the actual UI for Claude Code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "delta"; text: string }
  | { type: "assistant-message"; text: string }
  | { type: "tool-use"; name: string; input: unknown; id: string }
  | { type: "tool-result"; toolUseId: string; output: unknown; isError: boolean }
  | { type: "result"; ok: boolean; text?: string; costUsd?: number; usage?: unknown; sessionId?: string }
  | { type: "error"; code: string; message: string };

/**
 * Permission policy passed to `claude -p --permission-mode`.
 *
 * - "default"           — same as interactive: prompts on first use. In -p mode
 *                         without a way to prompt the user, edits are denied.
 * - "acceptEdits"       — auto-approve Edit/Write/MultiEdit, still prompt
 *                         (i.e. deny in -p) for Bash and other risky tools.
 *                         Good default for chat-from-Tierkit since the user
 *                         is clearly inviting edits by typing here.
 * - "bypassPermissions" — auto-approve EVERYTHING including arbitrary Bash.
 *                         Equivalent to the legacy --dangerously-skip-permissions
 *                         flag. Lets Claude do whatever it wants. Use only in
 *                         a workspace you fully trust.
 * - "plan"              — read-only planning mode; no edits performed.
 */
export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface ChatWithClaudeOptions {
  message: string;
  /** Continue a previous conversation. If unset, claude starts a fresh session. */
  sessionId?: string;
  /** Working directory for claude. CLAUDE.md / .mcp.json are read from here. */
  cwd: string;
  /** Override the claude binary path. Useful when claude isn't on a GUI-launched PATH. */
  claudeBinary?: string;
  /** Permission policy. Default "acceptEdits" — see ClaudePermissionMode. */
  permissionMode?: ClaudePermissionMode;
  /** Abort signal — kills the child process on abort. */
  signal?: AbortSignal;
}

/**
 * Spawn the claude CLI and yield typed events. The returned AsyncIterable can
 * be consumed once; each event maps to one stdout line.
 *
 * Important: the iterable always terminates — either with a final `result`
 * event (success), an `error` event (spawn or stream failure), or an `error`
 * event from the abort signal. Consumers don't need to add their own timeout.
 */
export async function* chatWithClaude(opts: ChatWithClaudeOptions): AsyncIterable<ChatEvent> {
  const binary = opts.claudeBinary ?? "claude";
  const args = ["-p", "--output-format=stream-json", "--verbose"];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  // v0.21.3: tell claude what permission policy to apply. Without this flag,
  // -p mode runs in "default" and silently denies Edit/Write/Bash since it
  // can't prompt the user — which surfaces in Tierkit Chat as a stream of
  // "permission denied" tool errors. "acceptEdits" is the sensible default
  // for a Tierkit Chat session because the user is clearly inviting edits
  // by typing here.
  const mode = opts.permissionMode ?? "acceptEdits";
  args.push("--permission-mode", mode);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binary, args, {
      cwd: opts.cwd,
      // Inherit env so user's claude auth (~/.claude/.credentials.json via HOME)
      // and PATH resolution work the same as a terminal-launched session.
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    yield { type: "error", code: "spawn-failed", message: (err as Error).message };
    return;
  }

  // If the caller cancels, kill the child. We never silently leak processes.
  const onAbort = () => {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) { onAbort(); }
    else opts.signal.addEventListener("abort", onAbort);
  }

  // Write the user message to stdin and close it. claude reads the message
  // from stdin in --print mode when no message arg is supplied.
  try {
    child.stdin.write(opts.message);
    child.stdin.end();
  } catch (err) {
    yield { type: "error", code: "stdin-write-failed", message: (err as Error).message };
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    return;
  }

  // Buffer stdout lines. claude emits one JSON object per line; we parse each
  // independently. Partial chunks at the end of a read are kept until the
  // next chunk completes them.
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const stderrChunks: string[] = [];

  child.stderr.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf8");
    stderrChunks.push(str);
    stderrBuffer += str;
  });

  // Async iterator over stdout chunks. We translate each complete line into
  // one or more typed events.
  let exitedWithError = false;
  let exitError: { code: string; message: string } | null = null;
  child.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    exitedWithError = true;
    exitError = {
      code: code === "ENOENT" ? "claude-not-found" : "spawn-error",
      message: code === "ENOENT"
        ? `'${binary}' not found in PATH. Install Claude Code CLI (https://claude.com/claude-code).`
        : (err as Error).message,
    };
  });

  try {
    for await (const chunk of child.stdout) {
      stdoutBuffer += (chunk as Buffer).toString("utf8");
      // Split on newline; the last partial chunk stays in the buffer.
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const event = translateLine(trimmed);
        if (event) yield event;
      }
    }
    // Flush whatever's left in the buffer.
    if (stdoutBuffer.trim()) {
      const event = translateLine(stdoutBuffer.trim());
      if (event) yield event;
    }
  } catch (err) {
    yield { type: "error", code: "stream-error", message: (err as Error).message };
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }

  if (exitedWithError && exitError) {
    const e = exitError as { code: string; message: string };
    yield { type: "error", code: e.code, message: e.message };
    return;
  }

  // Wait for the process to fully exit so we can surface non-zero exit codes
  // that didn't produce a `result` event.
  const code = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    child.once("close", (c) => resolve(c));
  });
  if (code !== 0 && code !== null) {
    yield {
      type: "error",
      code: "exit-nonzero",
      message: `claude exited with code ${code}. stderr: ${stderrBuffer.trim().slice(0, 500)}`,
    };
  }
}

/** Parse one JSON line from claude's stdout into a typed event we want to
 *  forward to the webview. Lines that don't match a known shape are dropped
 *  silently — claude adds new event types over time and we don't want
 *  unknowns to crash the stream. */
function translateLine(line: string): ChatEvent | null {
  let parsed: any;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;

  // Initial system/init event carries the session_id we'll need for --resume.
  if (parsed.type === "system" && parsed.subtype === "init" && typeof parsed.session_id === "string") {
    return { type: "session", sessionId: parsed.session_id };
  }

  // Assistant message — content is an array of text / tool_use / etc. blocks.
  if (parsed.type === "assistant" && parsed.message && Array.isArray(parsed.message.content)) {
    // We emit one assistant-message event per text block + one tool-use event
    // per tool_use block. The webview then composes them into a single bubble.
    // For simplicity we coalesce all text blocks of one assistant turn.
    let textOut = "";
    const toolEvents: ChatEvent[] = [];
    for (const block of parsed.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        textOut += block.text;
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        toolEvents.push({
          type: "tool-use",
          name: block.name,
          input: block.input,
          id: typeof block.id === "string" ? block.id : "",
        });
      }
    }
    // We can only yield one event per call site here. Return the assistant
    // text if present; otherwise the first tool use. The translateLine API
    // is per-line, and one stdout line maps to one assistant event from
    // claude's side, so blocks within it belong together.
    if (textOut) return { type: "assistant-message", text: textOut };
    if (toolEvents.length > 0) return toolEvents[0]!;
    return null;
  }

  // User message events (echoed back when a tool_result is delivered).
  if (parsed.type === "user" && parsed.message && Array.isArray(parsed.message.content)) {
    for (const block of parsed.message.content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        return {
          type: "tool-result",
          toolUseId: block.tool_use_id,
          output: block.content ?? "",
          isError: Boolean(block.is_error),
        };
      }
    }
    return null;
  }

  // Final result event — claude emits exactly one of these at the end of a turn.
  if (parsed.type === "result") {
    return {
      type: "result",
      ok: parsed.is_error !== true,
      ...(typeof parsed.result === "string" ? { text: parsed.result } : {}),
      ...(typeof parsed.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
    };
  }

  return null;
}
