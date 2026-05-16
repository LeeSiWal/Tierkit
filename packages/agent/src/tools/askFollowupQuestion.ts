import type { Tool, ToolResult, AgentContext } from "../types.js";

/**
 * The agent asks the user a clarifying question. The actual question→answer round-trip
 * is handled by the runtime layer (sidebar UI / SSE client) — this tool just packages
 * the model's question as a tool result that the runtime renders specially.
 *
 * Unlike write_file / execute_command, this tool isn't gated by `approval` — it's a
 * read-only question. The runtime detects `name === "ask_followup_question"` events and
 * shows a text input rather than just text output. The next user message becomes the
 * answer (as the next user turn in the conversation).
 *
 * For 0.4.2: we return the question as-is in the result content and let the user respond
 * by typing in the composer. Future polish: dedicated input UI with the question shown
 * inline and an [Answer] button.
 */
export const askFollowupQuestionTool: Tool = {
  name: "ask_followup_question",
  description:
    "Ask the user a clarifying question when the task is genuinely ambiguous and you cannot " +
    "make progress without their input. Prefer reading files and trying things first. " +
    "After asking, STOP — wait for the user's response in their next message. " +
    "Each question should be specific and answerable in one or two sentences.",
  parameters: [
    {
      name: "question",
      type: "string",
      description: "The specific question to ask the user.",
      required: true,
    },
    {
      name: "suggested_responses",
      type: "array",
      description: "Optional array of suggested response strings the user can pick from.",
      required: false,
    },
  ],
  example: [
    "<ask_followup_question>",
    "<question>Should I add tests with the new function, or skip tests for this experimental feature?</question>",
    "<suggested_responses>[\"Add tests\", \"Skip tests for now\"]</suggested_responses>",
    "</ask_followup_question>",
  ].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, _ctx: AgentContext): Promise<ToolResult> {
    const question = String(args.question ?? "").trim();
    if (!question) {
      return {
        ok: false,
        content: "[invalid-args] missing required parameter `question`",
        error: { code: "invalid-args", message: "missing question" },
      };
    }
    const suggestions = Array.isArray(args.suggested_responses)
      ? (args.suggested_responses as unknown[]).map((s) => String(s)).filter(Boolean)
      : [];

    // The result content is the question itself — the runtime layer sees `name ===
    // "ask_followup_question"` in the tool_call event and renders an answer prompt UI.
    // The model then sees this same content in the tool result, reminding it that the
    // user's next message will be the answer.
    return {
      ok: true,
      content:
        `[awaiting user response]\nQuestion: ${question}` +
        (suggestions.length > 0 ? `\nSuggested responses:\n  - ${suggestions.join("\n  - ")}` : ""),
    };
  },
};
