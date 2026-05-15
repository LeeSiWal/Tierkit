import type { ChatMessage } from "../model/providers/chatTypes.js";

export type RunMode = "plan" | "review" | "execute";

const SYSTEM_PROMPTS: Record<RunMode, string> = {
  plan: `You are operating in PLAN mode for Tierkit.

Your job is to think first, then write a clear, concrete implementation plan. Do NOT produce code yet.

Required structure:
1. **Restate the task** in your own words (one paragraph).
2. **What's known.** Constraints, existing code, prior decisions.
3. **What's unknown / assumptions.** If any block progress, say so explicitly.
4. **Approaches (1–3).** For each: rough design, files affected, risk, effort.
5. **Recommended next step** — a single concrete action.

Do not produce code listings beyond 3 illustrative lines per approach.`,

  review: `You are operating in REVIEW mode for Tierkit.

Your job is to read the supplied context (a diff, files, or a description of changes) and produce a structured review. Do NOT propose new features.

For each finding:
- **Severity**: blocker / warning / nit
- **Location**: path/to/file:line if known, otherwise the section
- **What's wrong**
- **Suggested change** (specific, not "consider improving")

End with a one-line verdict: \`ship it\`, \`needs fixes\`, or \`needs redesign\`.`,

  execute: `You are operating in EXECUTE mode for Tierkit.

Carry out the task directly. Keep responses tight: ship the smallest change that addresses the task. Surface assumptions only when they materially affect the answer.

If the task is unsafe to execute without more context, switch to PLAN posture instead — name the missing piece and stop.`,
};

export interface BuildTaskContextInput {
  task: string;
  mode: RunMode;
  /** Optional extra system content prepended to the mode preamble (e.g. plugin rules). */
  extraSystem?: string;
}

export interface BuildTaskContextResult {
  messages: ChatMessage[];
  /** The system prompt that was injected, for transparency / logging. */
  systemPrompt: string;
}

/**
 * Build the message array Tierkit sends to a model for `route run`. Two messages:
 * - a `system` message with the mode preamble (plus optional plugin rules), and
 * - a `user` message containing the verbatim task.
 *
 * Kept deliberately minimal: no examples, no few-shot, no chain-of-thought scaffolding.
 * Plugins that want richer prompts can layer on top via `extraSystem`.
 */
export function buildTaskContext(input: BuildTaskContextInput): BuildTaskContextResult {
  const preamble = SYSTEM_PROMPTS[input.mode];
  const systemPrompt = input.extraSystem
    ? `${input.extraSystem.trim()}\n\n${preamble}`
    : preamble;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input.task },
  ];
  return { messages, systemPrompt };
}
