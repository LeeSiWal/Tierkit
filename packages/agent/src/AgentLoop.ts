/**
 * The agent loop — drives the model through tool-call rounds until task completion.
 *
 * Each turn:
 *   1. Build the conversation: system prompt + history
 *   2. Call Tierkit's `/v1/openai/chat/completions` (so all Tierkit policy applies — routing,
 *      viability, secret redaction, command-gate for tool_commands, budget, sessions,
 *      plugin-rule injection, tool-shim)
 *   3. Parse the response for XML tool calls (Cline-style) + native tool_calls (if any)
 *   4. If `<task_complete>` appears, finish
 *   5. Otherwise execute each tool call (with optional user approval for destructive ops)
 *   6. Append tool results to history, loop
 *
 * Yields `AgentEvent`s as it goes so callers can stream them — sidebar / SSE / tests
 * subscribe via `for await`. The runtime layer transforms these events into UI updates
 * or SSE chunks.
 */
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentRunInput,
  AgentToolCall,
  Tool,
  ToolResult,
} from "./types.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { parseAgentResponse } from "./parseResponse.js";
import { DEFAULT_TOOLS, findTool } from "./tools/index.js";

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_BASE_URL = "http://127.0.0.1:4101";

export interface RunAgentDeps {
  /**
   * Override the model-call transport. Defaults to fetch against
   * `${tierkitBaseUrl}/v1/openai/chat/completions`. Tests inject a mock here.
   */
  callModel?: (req: ModelCallRequest) => Promise<ModelCallResponse>;
  /**
   * Override the registered tools. Defaults to `DEFAULT_TOOLS`. The runtime layer can
   * narrow this set based on plugin mode permissions.
   */
  tools?: Tool[];
}

export interface ModelCallRequest {
  model: string;
  messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[];
}

export interface ModelCallResponse {
  text: string;
  /** Native structured tool_calls if the provider returned them. */
  toolCalls?: AgentToolCall[];
}

export async function* runAgent(input: AgentRunInput, deps: RunAgentDeps = {}): AsyncIterable<AgentEvent> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const tierkitBaseUrl = input.tierkitBaseUrl ?? DEFAULT_BASE_URL;
  const modelId = input.modelId ?? "auto";
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const tools = deps.tools ?? DEFAULT_TOOLS;
  const callModel = deps.callModel ?? makeDefaultCallModel(tierkitBaseUrl);
  const ctx: AgentContext = {
    cwd,
    env,
    tierkitBaseUrl,
    ...(input.approve ? { approve: input.approve } : {}),
  };

  const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  yield { type: "task_start", taskId, task: input.task };

  // Build initial conversation. The system prompt has tool catalog + format rules.
  // Plugin rules are injected DOWNSTREAM by the Tierkit daemon (via `injectPluginRules`),
  // so we don't repeat them here — that would double-inject. Caller wanting standalone
  // operation should pass `activeRules` to `buildSystemPrompt` directly.
  const systemPrompt = buildSystemPrompt({ tools, cwd, ...(input.mode ? { mode: input.mode } : {}) });
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input.task },
  ];
  const knownToolNames = tools.map((t) => t.name);

  let turn = 0;
  while (turn < maxTurns) {
    turn++;

    // ── Call the model via Tierkit daemon ─────────────────────────────────
    let modelResponse: ModelCallResponse;
    try {
      modelResponse = await callModel({
        model: modelId,
        messages: messages.map((m) => toWireMessage(m)),
      });
    } catch (err) {
      yield { type: "error", code: "model-call-failed", message: (err as Error).message };
      yield { type: "turn_end", reason: "error" };
      return;
    }

    // Surface the raw text so the UI can show "thinking" even before tools fire.
    if (modelResponse.text && modelResponse.text.trim().length > 0) {
      yield { type: "assistant_text", text: modelResponse.text };
    }

    // ── Parse for tool calls ──────────────────────────────────────────────
    const parsed = parseAgentResponse(modelResponse.text, knownToolNames);

    // Prefer Tierkit's parsed XML calls. If the provider also returned native tool_calls
    // (e.g., a strong model that did emit structured), merge them — but de-dup by name+args.
    const allCalls: AgentToolCall[] = [...parsed.toolCalls];
    for (const native of modelResponse.toolCalls ?? []) {
      const dup = allCalls.find(
        (c) => c.name === native.name && JSON.stringify(c.args) === JSON.stringify(native.args),
      );
      if (!dup) allCalls.push(native);
    }

    // Record what the assistant emitted (for future turns' context).
    messages.push({
      role: "assistant",
      content: parsed.narrativeText,
      ...(allCalls.length > 0 ? { toolCalls: allCalls } : {}),
    });

    // ── Task complete? ────────────────────────────────────────────────────
    if (parsed.taskComplete) {
      yield { type: "task_complete", taskId, turnCount: turn };
      return;
    }

    // ── No tool calls → conversation done (or stuck) ──────────────────────
    if (allCalls.length === 0) {
      yield { type: "turn_end", reason: "no_tool_calls" };
      return;
    }

    // ── Execute each tool call in order ──────────────────────────────────
    for (const call of allCalls) {
      yield { type: "tool_call", call };
      const tool = findTool(call.name) ?? tools.find((t) => t.name === call.name);
      if (!tool) {
        const result: ToolResult = {
          ok: false,
          content: `[unknown-tool] no tool named "${call.name}" — available: ${knownToolNames.join(", ")}`,
          error: { code: "unknown-tool", message: `no such tool: ${call.name}` },
        };
        yield { type: "tool_result", call, result };
        messages.push({ role: "tool", content: result.content, toolCallId: call.id });
        continue;
      }

      // Approval gate.
      if (tool.approval === "always" && ctx.approve) {
        yield { type: "tool_approval_pending", call };
        let approved = false;
        try {
          approved = await ctx.approve(call);
        } catch {
          approved = false;
        }
        yield { type: "tool_approval_resolved", call, approved };
        if (!approved) {
          const result: ToolResult = {
            ok: false,
            content: `[denied] user did not approve ${tool.name}`,
            error: { code: "denied", message: "user did not approve" },
          };
          yield { type: "tool_result", call, result };
          messages.push({ role: "tool", content: result.content, toolCallId: call.id });
          continue;
        }
      }

      // Run the tool.
      let result: ToolResult;
      try {
        result = await tool.execute(call.args, ctx);
      } catch (err) {
        result = {
          ok: false,
          content: `[tool-error] ${(err as Error).message}`,
          error: { code: "tool-error", message: (err as Error).message },
        };
      }
      yield { type: "tool_result", call, result };
      messages.push({ role: "tool", content: result.content, toolCallId: call.id });
    }
  }

  // Hit the turn cap without completing.
  yield { type: "turn_end", reason: "max_turns" };
}

function toWireMessage(m: AgentMessage): {
  role: string;
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
} {
  const out: {
    role: string;
    content: string;
    tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  } = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  return out;
}

function makeDefaultCallModel(tierkitBaseUrl: string) {
  return async function defaultCallModel(req: ModelCallRequest): Promise<ModelCallResponse> {
    const res = await fetch(`${tierkitBaseUrl}/v1/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
      }),
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`tierkit daemon HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      error?: { message: string; code?: string };
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };
    if (body.error) {
      throw new Error(`${body.error.code ?? "error"}: ${body.error.message}`);
    }
    const choice = body.choices?.[0]?.message;
    const text = choice?.content ?? "";
    const toolCalls: AgentToolCall[] = (choice?.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.function.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      return { id: tc.id, name: tc.function.name, args };
    });
    return { text, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  };
}
