/**
 * Tool-shim layer — bridges OpenAI structured tool calling to weak local models that
 * emit tool calls as text rather than as a structured `tool_calls` field.
 *
 * The problem: When a coding agent (Roo Code, Cline, Continue) sends an OpenAI-format
 * `tools` array to a small local model via Ollama, the model often understands what it
 * wants to call but emits the call as natural-language text or JSON-in-content rather
 * than using Ollama's structured `tool_calls` response field. The caller then sees
 * `tool_calls: undefined` and complains "the model didn't use any tool".
 *
 * The fix: This shim takes the same path Cline/Roo themselves take internally —
 *   1. Convert OpenAI `tools` array into an XML-tag instruction block in the system prompt
 *   2. Strip `tools` from the outgoing provider request (model sees only the instructions)
 *   3. Parse the model's text response for XML tags or known JSON shapes
 *   4. Translate matched patterns to OpenAI `tool_calls` for the caller
 *
 * Supported response patterns:
 *   - XML tags: `<tool_name>\n<param>value</param>\n</tool_name>`
 *   - OpenAI-shape JSON in content: `{"name": "tool_name", "arguments": {...}}`
 *   - JSON in code fence: ` ```json\n{...}\n``` `
 *
 * Decisions:
 *   - Code fences and surrounding narrative text are preserved as cleaned content
 *   - Multiple tool calls in one response are supported (some models do this)
 *   - Unknown tool names are ignored (treated as plain text)
 *   - Malformed JSON / unclosed XML are ignored
 */
import type { ToolCall, ToolDefinition } from "./providers/chatTypes.js";

/**
 * Build the system prompt block that teaches the model to call tools via XML tags.
 * Inserted as a `system` message before the caller's messages when the shim is active.
 */
export function buildXmlToolInstructions(tools: ToolDefinition[]): string {
  const lines: string[] = [];
  lines.push("# Available Tools");
  lines.push("");
  lines.push(
    "You have access to the following tools. To call a tool, emit exactly one XML tag block in your response. " +
      "Each parameter goes in its own nested tag. Do NOT wrap the tags in code fences. " +
      "If you do not need a tool, respond with plain text.",
  );
  lines.push("");
  lines.push("Format:");
  lines.push("```");
  lines.push("<tool_name>");
  lines.push("<param_name>value</param_name>");
  lines.push("</tool_name>");
  lines.push("```");
  lines.push("");

  for (const t of tools) {
    const fn = t.function;
    lines.push(`## ${fn.name}`);
    if (fn.description) lines.push(fn.description);
    const params = (fn.parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | undefined) ?? {};
    const props = params.properties ?? {};
    const required = new Set(params.required ?? []);
    if (Object.keys(props).length > 0) {
      lines.push("");
      lines.push("Parameters:");
      for (const [name, spec] of Object.entries(props)) {
        const req = required.has(name) ? "required" : "optional";
        const type = spec.type ?? "string";
        const desc = spec.description ?? "";
        lines.push(`  - ${name} (${type}, ${req})${desc ? ": " + desc : ""}`);
      }
    }
    lines.push("");
    // One concrete example to anchor the format.
    const exampleParams = Object.keys(props);
    if (exampleParams.length > 0) {
      lines.push("Example:");
      lines.push(`<${fn.name}>`);
      for (const p of exampleParams) lines.push(`<${p}>...</${p}>`);
      lines.push(`</${fn.name}>`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/**
 * Scan response text for tool calls and convert to OpenAI structured form. Returns the
 * extracted `toolCalls` array plus the original text with the call markers removed (so
 * the caller can show only the narrative portion).
 *
 * Order of strategies (first match wins per region of text):
 *   1. XML tags matching one of the `knownTools` names
 *   2. Code-fenced JSON matching `{name: ..., arguments: {...}}`
 *   3. Bare JSON object matching the same shape, when it consumes the whole text
 */
export interface ExtractedToolCalls {
  toolCalls: ToolCall[];
  cleanedContent: string;
}

export function extractToolCallsFromText(
  text: string,
  knownToolNames: string[],
): ExtractedToolCalls {
  if (!text || text.length === 0) return { toolCalls: [], cleanedContent: text };

  const toolCalls: ToolCall[] = [];
  let cleaned = text;
  const names = new Set(knownToolNames);

  // ── Strategy 1: XML tags ──────────────────────────────────────────────────
  // Find each <tool>...</tool> block whose tool name matches a known tool.
  for (const name of names) {
    const re = new RegExp(`<${escapeRegex(name)}>([\\s\\S]*?)</${escapeRegex(name)}>`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const inner = m[1] ?? "";
      const args = parseXmlParams(inner);
      toolCalls.push({
        id: nextCallId(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
      // Remove this block from the visible content so the caller sees only narrative.
      cleaned = cleaned.slice(0, m.index) + cleaned.slice(m.index + m[0].length);
      re.lastIndex = m.index; // continue scanning from the same position
    }
  }
  if (toolCalls.length > 0) return { toolCalls, cleanedContent: cleaned.trim() };

  // ── Strategy 2: Code-fenced JSON ──────────────────────────────────────────
  // Look for ```json {...} ``` or ``` {...} ``` blocks containing { "name": "X", "arguments": {...} }
  const fenceRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(cleaned)) !== null) {
    const parsed = tryParseOpenAIJson(fm[1] ?? "");
    if (parsed && names.has(parsed.name)) {
      toolCalls.push({
        id: nextCallId(),
        type: "function",
        function: { name: parsed.name, arguments: parsed.arguments },
      });
      cleaned = cleaned.slice(0, fm.index) + cleaned.slice(fm.index + fm[0].length);
      fenceRe.lastIndex = fm.index;
    }
  }
  if (toolCalls.length > 0) return { toolCalls, cleanedContent: cleaned.trim() };

  // ── Strategy 3: Bare JSON consuming entire trimmed content ────────────────
  // qwen2.5-coder:7b's observed pattern: content is purely a JSON object describing the
  // call, no narrative. If we can parse the whole content as such, treat as a tool call.
  const trimmed = cleaned.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const parsed = tryParseOpenAIJson(trimmed);
    if (parsed && names.has(parsed.name)) {
      toolCalls.push({
        id: nextCallId(),
        type: "function",
        function: { name: parsed.name, arguments: parsed.arguments },
      });
      return { toolCalls, cleanedContent: "" };
    }
  }

  return { toolCalls: [], cleanedContent: text };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse parameters from inside an XML tool tag. Looks for `<name>value</name>` patterns
 * at the top level. Nested tags are kept as their inner text (so JSON-string params work).
 */
function parseXmlParams(inner: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const re = /<(\w[\w-]*)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const key = m[1]!;
    const raw = (m[2] ?? "").trim();
    // Try parsing values as JSON (so arrays / objects / numbers / bools work). Fall back
    // to raw string. This matches how Cline/Roo treat XML tool params.
    let value: unknown = raw;
    if (
      (raw.startsWith("{") && raw.endsWith("}")) ||
      (raw.startsWith("[") && raw.endsWith("]")) ||
      raw === "true" ||
      raw === "false" ||
      raw === "null" ||
      /^-?\d+(\.\d+)?$/.test(raw)
    ) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    params[key] = value;
  }
  return params;
}

/** Try to interpret `text` as `{"name": "...", "arguments": {...}}`. Returns null on failure. */
function tryParseOpenAIJson(text: string): { name: string; arguments: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  // Some models put `arguments` as an object, others as a JSON-string. Normalize to string.
  let argString: string;
  if (typeof o.arguments === "string") argString = o.arguments;
  else if (o.arguments && typeof o.arguments === "object") argString = JSON.stringify(o.arguments);
  else argString = "{}";
  return { name: o.name, arguments: argString };
}

let callIdCounter = 0;
function nextCallId(): string {
  callIdCounter = (callIdCounter + 1) >>> 0;
  return `call_shim_${Date.now().toString(36)}_${callIdCounter}`;
}
