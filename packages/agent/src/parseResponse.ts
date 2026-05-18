/**
 * Parser for the model's response — extracts XML tool tags and separates them from any
 * narrative text the model may have included.
 *
 * Cline / Roo Code use this format because models reliably emit nested XML when given
 * one example, even at smaller sizes. The parser tolerates:
 *   - leading/trailing narrative text (preserved as `narrativeText`)
 *   - multiple tool calls in one response (rare but legal — we execute in order)
 *   - JSON-typed param values (arrays, numbers, bools) — parsed as JSON if shape matches
 *   - whitespace around tags
 *
 * Things it does NOT parse:
 *   - tags whose names aren't in `knownToolNames` (treated as plain text — the model
 *     might mention `<foo>` in narrative without intending a tool call)
 *   - JSON-in-content blocks (covered by `@tierkit/core`'s toolShim parser as a fallback
 *     when the model bypasses XML entirely — we layer that AFTER this parser if no XML
 *     matches)
 */
import type { AgentToolCall } from "./types.js";

export interface ParsedResponse {
  /** Tool calls extracted in the order they appear in the response. */
  toolCalls: AgentToolCall[];
  /** Original text with all tool-tag blocks removed. May be empty. */
  narrativeText: string;
  /**
   * True if the response contained `<task_complete>...</task_complete>` — the model is
   * declaring the task done. The runtime stops the loop and surfaces the inner text as
   * the final summary.
   */
  taskComplete: { summary: string } | undefined;
}

export function parseAgentResponse(text: string, knownToolNames: string[]): ParsedResponse {
  if (!text || text.length === 0) return { toolCalls: [], narrativeText: text, taskComplete: undefined };

  // Reserved "tools" used as control signals, not registered tools.
  const RESERVED = new Set(["task_complete"]);

  let working = text;
  const toolCalls: AgentToolCall[] = [];
  let taskComplete: { summary: string } | undefined;

  // Build the list of tag names we'll search for.
  const allNames = new Set<string>([...knownToolNames, ...RESERVED]);

  // ── Strategy A: XML tags <tool_name>...</tool_name> (Cline / Roo style) ──
  // Repeatedly find the FIRST tag block of any known name, extract it, then re-scan the
  // remainder. This handles unordered names correctly (the for-each-name approach can
  // misorder when calls of different names interleave in the source text).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = findFirstTagBlock(working, allNames);
    if (!next) break;

    const { name, inner, start, end } = next;
    const args = parseXmlParams(inner);

    if (name === "task_complete") {
      // `summary` is either a nested <summary>...</summary> or the whole inner text.
      const summary =
        (args.summary !== undefined ? String(args.summary) : inner.trim()) || "(no summary)";
      taskComplete = { summary };
    } else {
      toolCalls.push({
        id: `call_${Date.now().toString(36)}_${toolCalls.length}`,
        name,
        args,
      });
    }

    working = working.slice(0, start) + working.slice(end);
  }

  // ── Strategy B: Mistral-family native marker [TOOL_CALLS]name[ARGS]{json} ──
  // Devstral / Mistral models trained on function calling emit this exact text when their
  // native format isn't being interpreted by the runtime. We extract them here so they're
  // not dumped as raw text into the chat.
  const mistralRe = /\[TOOL_CALLS\]\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\[ARGS\]\s*(\{[\s\S]*?\})/g;
  let mm: RegExpExecArray | null;
  const mistralRanges: Array<{ start: number; end: number }> = [];
  while ((mm = mistralRe.exec(working)) !== null) {
    const name = mm[1]!;
    const argsRaw = mm[2]!;
    if (!allNames.has(name)) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(argsRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON args — skip; will be left in narrativeText.
      continue;
    }
    if (name === "task_complete") {
      const summary = String(args.summary ?? "(no summary)");
      taskComplete = { summary };
    } else {
      toolCalls.push({
        id: `call_${Date.now().toString(36)}_${toolCalls.length}`,
        name,
        args,
      });
    }
    mistralRanges.push({ start: mm.index, end: mm.index + mm[0].length });
  }
  // Splice out the consumed ranges from working (back-to-front so offsets stay valid).
  for (let i = mistralRanges.length - 1; i >= 0; i--) {
    const { start, end } = mistralRanges[i]!;
    working = working.slice(0, start) + working.slice(end);
  }

  return { toolCalls, narrativeText: working.trim(), taskComplete };
}

interface TagBlock {
  name: string;
  inner: string;
  start: number;
  end: number;
}

/** Find the lexically-first opening tag of any name in the set; return that tag's block. */
function findFirstTagBlock(text: string, names: Set<string>): TagBlock | null {
  let earliest: TagBlock | null = null;
  for (const name of names) {
    const open = new RegExp(`<${escapeRegex(name)}\\s*>`, "g");
    open.lastIndex = 0;
    const m = open.exec(text);
    if (!m) continue;
    const start = m.index;
    if (earliest && start >= earliest.start) continue;
    const close = `</${name}>`;
    const closeIdx = text.indexOf(close, start + m[0].length);
    if (closeIdx === -1) continue;
    const inner = text.slice(start + m[0].length, closeIdx);
    earliest = { name, inner, start, end: closeIdx + close.length };
  }
  return earliest;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse `<name>value</name>` pairs at the top level of a tag's inner text. */
function parseXmlParams(inner: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const re = /<(\w[\w-]*)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const key = m[1]!;
    const raw = (m[2] ?? "").trim();
    params[key] = coerce(raw);
  }
  return params;
}

/** Attempt to coerce a string into a JSON-typed value when its shape allows. */
function coerce(raw: string): unknown {
  if (raw === "") return "";
  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]"))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}
