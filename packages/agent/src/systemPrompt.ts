/**
 * System prompt builder for the Tierkit agent.
 *
 * The model needs three things in the system prompt to drive the agent loop well:
 *   1. **Role + behavior expectations** — what the agent does, how it should respond
 *   2. **Tool catalog** — every available tool with parameters + usage example in
 *      Cline-style XML format
 *   3. **Workspace context** — cwd, OS info, mode (when applicable)
 *
 * Format follows Cline / Roo Code's convention because (a) most modern code models have
 * been exposed to that format during training, and (b) it's robust against models that
 * fail to emit OpenAI structured tool_calls — they just emit `<tool_name>...</tool_name>`
 * as text and Tierkit's parser extracts it.
 *
 * Workflow rules (plan-first, tests-first, etc.) come from active Tierkit plugins and
 * are injected by the daemon's `/v1/llm-call` path — NOT by this function. Caller passes
 * them in `activeRules` only when running outside the daemon (e.g. direct invocation
 * from a test). When called from the daemon, rules are appended downstream.
 */
import type { Tool, ToolParam } from "./types.js";
import os from "node:os";

export interface BuildSystemPromptInput {
  tools: Tool[];
  cwd: string;
  /** Optional mode name (e.g., "planner", "reviewer") — shown to the model so it can tone its responses. */
  mode?: string;
  /**
   * Optional rule snippets (markdown). When omitted, the daemon's plugin-rule injection
   * handles this. Set only when you want to bypass the daemon and inject directly.
   */
  activeRules?: string[];
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const sections: string[] = [];

  // ── Role ───────────────────────────────────────────────────────────────────
  sections.push(
    "You are Tierkit Agent, an autonomous coding assistant. You complete the user's task " +
      "by reading the relevant files, making changes when needed, and running commands when " +
      "appropriate. You operate inside a real workspace — your tool calls have real effects.",
  );

  // ── Workspace context ──────────────────────────────────────────────────────
  sections.push(
    [
      "# Workspace",
      "",
      `Working directory: ${input.cwd}`,
      `Operating system: ${os.platform()} (${os.release()})`,
      input.mode ? `Active mode: ${input.mode}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  // ── Tool catalog ───────────────────────────────────────────────────────────
  sections.push(formatToolCatalog(input.tools));

  // ── Output format rules ────────────────────────────────────────────────────
  sections.push(
    [
      "# Output Format",
      "",
      "On every turn, do one of two things:",
      "",
      "1. **Call a tool.** Emit exactly one XML tag block. Each parameter is its own nested tag. " +
        "Do NOT wrap the block in code fences. After the tag, you may optionally include a brief " +
        "explanation; the system will execute the tool and return the result on the next turn.",
      "",
      "2. **Complete the task.** When you have finished, emit a `<task_complete>` block with a " +
        "summary of what you did. Do NOT call any other tools in that turn.",
      "",
      "Format example (calling a tool):",
      "```",
      "<read_file>",
      "<path>src/main.ts</path>",
      "</read_file>",
      "```",
      "",
      "Stop and emit `<ask_followup_question>` ONLY when the task is genuinely ambiguous and you " +
        "cannot make progress without user input. Prefer reading files and trying things over asking.",
    ].join("\n"),
  );

  // ── Plugin rules (caller-supplied, optional) ───────────────────────────────
  if (input.activeRules && input.activeRules.length > 0) {
    sections.push(["# Rules", "", ...input.activeRules].join("\n"));
  }

  return sections.join("\n\n");
}

function formatToolCatalog(tools: Tool[]): string {
  if (tools.length === 0) return "# Tools\n\n(no tools available in this mode)";
  const lines: string[] = ["# Tools", ""];
  for (const t of tools) {
    lines.push(`## ${t.name}`);
    lines.push(t.description);
    if (t.parameters.length > 0) {
      lines.push("");
      lines.push("Parameters:");
      for (const p of t.parameters) lines.push(`  - ${formatParam(p)}`);
    }
    lines.push("");
    if (t.example) {
      lines.push("Example:");
      lines.push(t.example);
    } else if (t.parameters.length > 0) {
      // Auto-generated example
      lines.push("Example:");
      lines.push(`<${t.name}>`);
      for (const p of t.parameters) lines.push(`<${p.name}>...</${p.name}>`);
      lines.push(`</${t.name}>`);
    } else {
      lines.push("Example:");
      lines.push(`<${t.name}></${t.name}>`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatParam(p: ToolParam): string {
  const req = p.required ? "required" : "optional";
  return `${p.name} (${p.type}, ${req}): ${p.description}`;
}
