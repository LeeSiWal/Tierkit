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
import { createGitCheckpoint } from "./tools/gitCheckpoint.js";

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_BASE_URL = "http://127.0.0.1:4101";

/** Tool names that mutate the workspace — we snapshot via git stash create before running. */
const DESTRUCTIVE_TOOLS = new Set(["write_file", "apply_diff", "search_and_replace"]);

export interface RunAgentDeps {
  /**
   * Override the model-call transport. Defaults to fetch against
   * `${tierkitBaseUrl}/v1/openai/chat/completions`. Tests inject a mock here.
   */
  callModel?: (req: ModelCallRequest) => Promise<ModelCallResponse>;
  /**
   * Optional streaming transport. When provided AND the surrounding code is iterating
   * agent events, AgentLoop uses this in preference to `callModel`. Yields raw text
   * chunks as they arrive, then a final summary with the full text + tool_calls + usage.
   * Tests can leave this undefined to fall back to non-streaming behavior.
   */
  streamModel?: (req: ModelCallRequest) => AsyncIterable<ModelStreamEvent>;
  /**
   * Override the registered tools. Defaults to `DEFAULT_TOOLS`. The runtime layer can
   * narrow this set based on plugin mode permissions.
   */
  tools?: Tool[];
}

export type ModelStreamEvent =
  | { type: "chunk"; text: string }
  | { type: "done"; response: ModelCallResponse }
  | { type: "error"; message: string };

export interface ModelCallRequest {
  model: string;
  /** Each message's content may be a plain string or an array of OpenAI content parts
   *  (text + image_url). Tools and helpers normalize between the two as needed. */
  messages: { role: string; content: string | unknown[]; tool_calls?: unknown; tool_call_id?: string }[];
  /**
   * Optional OpenAI-format tools array. Sent only when we want to force the model into
   * a specific tool call via `tool_choice` (otherwise the system prompt's XML catalog is
   * enough). When provided, the provider passes these through; Ollama uses them to bias
   * its native tool_calls AND, when `tool_choice: "required"` is set, to drive its
   * `format` JSON schema.
   */
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  /**
   * Force a tool call. "required" → model MUST call one of `tools`. {type:function,...} →
   * force a specific tool. Anthropic/OpenAI honor this natively; Ollama maps to `format`.
   */
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
}

export interface ModelCallResponse {
  text: string;
  /** Native structured tool_calls if the provider returned them. */
  toolCalls?: AgentToolCall[];
  /** Token usage as returned by the Tierkit daemon (openai-compat shape). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Profile id that actually served the call (router may pick something different from input). */
  profileId?: string;
}

export async function* runAgent(input: AgentRunInput, deps: RunAgentDeps = {}): AsyncIterable<AgentEvent> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const tierkitBaseUrl = input.tierkitBaseUrl ?? DEFAULT_BASE_URL;
  const modelId = input.modelId ?? "auto";
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const tools = deps.tools ?? DEFAULT_TOOLS;
  const callModel = deps.callModel ?? makeDefaultCallModel(tierkitBaseUrl);
  // Edit-intent auto-detection. Matches Korean + English action verbs. Used as a heuristic:
  // when the user's initial task hits this regex AND a turn ends with no tool calls, we
  // retry once with forced tool_choice. Conservative — false positives just mean ONE extra
  // turn with forced tooling, which the model can still satisfy by calling read first if
  // it wants (read tools are also in the force schema when intent is detected from a
  // fresh task with no read context yet).
  const EDIT_INTENT_RE = /\b(fix|edit|change|modify|implement|add|remove|write|refactor|replace|create|update|rewrite|delete|insert)\b|수정|고쳐|바꿔|구현|만들어|추가|삭제|작성|리팩토|덮어|편집/i;
  const editIntent = EDIT_INTENT_RE.test(input.task);
  const forceEditMode = input.forceEdit === true;
  // Tracks whether the manual or auto force has already been used. Caps auto-retry at 1
  // per task so a stuck model doesn't loop forever on the force path.
  let autoForceUsed = false;
  let forceToolThisTurn = false;
  // Streaming is OPTIONAL. When tests inject a callModel without a streamModel, we
  // honor that (existing test contract) by leaving streamModel undefined and falling
  // through to the non-streaming path inside the loop. Only when neither is overridden
  // does the default streaming transport kick in.
  const streamModel = deps.streamModel ?? (deps.callModel ? undefined : makeDefaultStreamModel(tierkitBaseUrl));
  const ctx: AgentContext = {
    cwd,
    env,
    tierkitBaseUrl,
    ...(input.approve ? { approve: input.approve } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
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
    {
      role: "user",
      content: input.task,
      ...(input.attachments && input.attachments.length > 0 ? { images: input.attachments } : {}),
    },
  ];
  const knownToolNames = tools.map((t) => t.name);

  // Threshold above which we start replacing older tool results with summaries. Conservative:
  // we keep system + first user turn + the most recent COMPRESS_KEEP_TAIL messages
  // verbatim, and replace tool messages older than that with a 1-line summary. The agent's
  // own assistant narrative is preserved (it's relatively small and the model uses it for
  // self-orientation).
  const COMPRESS_AFTER_MESSAGES = 40;
  const COMPRESS_KEEP_TAIL = 16;

  let turn = 0;
  while (turn < maxTurns) {
    turn++;

    // History compression — trim large old tool results to keep context budget sane.
    if (messages.length > COMPRESS_AFTER_MESSAGES) {
      compressOldToolResults(messages, COMPRESS_KEEP_TAIL);
    }

    // ── Force-tool-call gate ──────────────────────────────────────────────
    // When forceToolThisTurn is set (either from manual `forceEdit` toggle after stall,
    // or auto-detected via edit intent + previous-turn stall), narrow the tools array
    // to write-class tools only and ask the provider to enforce `tool_choice: "required"`.
    // Read tools stay out of the force schema so the model commits to an edit instead
    // of looping on read.
    const FORCE_TOOL_NAMES = ["write_file", "apply_diff", "search_and_replace"];
    const forceTools = forceToolThisTurn
      ? tools
          .filter((t) => FORCE_TOOL_NAMES.includes(t.name))
          .map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: toolParamsToJsonSchema(t.parameters),
            },
          }))
      : undefined;

    // ── Call the model via Tierkit daemon (streaming when available) ──────
    // Stream chunks straight to the UI so the user sees text appearing as it generates.
    // After the stream completes we parse the full text for tool calls and emit a final
    // assistant_text event whose text REPLACES the streamed bubble (this is how we
    // strip raw <tool_xml> blocks out of the display without sacrificing streaming).
    // When streamModel is undefined (test injects callModel only), use callModel.
    let modelResponse: ModelCallResponse | undefined;
    try {
      if (streamModel) {
        let streamFailed: string | undefined;
        for await (const ev of streamModel({
          model: modelId,
          messages: messages.map((m) => toWireMessage(m)),
          ...(forceTools ? { tools: forceTools, tool_choice: "required" as const } : {}),
        })) {
          if (ev.type === "chunk") {
            if (ev.text.length > 0) yield { type: "delta", text: ev.text, turn };
          } else if (ev.type === "done") {
            modelResponse = ev.response;
          } else if (ev.type === "error") {
            streamFailed = ev.message;
            break;
          }
        }
        if (streamFailed) {
          // Fall back to non-streaming so we still get a response (and so existing
          // fallback / candidate-walker behavior in openaiCompat still applies).
          modelResponse = await callModel({
            model: modelId,
            messages: messages.map((m) => toWireMessage(m)),
            ...(forceTools ? { tools: forceTools, tool_choice: "required" as const } : {}),
          });
        }
      } else {
        modelResponse = await callModel({
          model: modelId,
          messages: messages.map((m) => toWireMessage(m)),
          ...(forceTools ? { tools: forceTools, tool_choice: "required" as const } : {}),
        });
      }
      if (!modelResponse) {
        throw new Error("model call ended without a response");
      }
    } catch (err) {
      yield { type: "error", code: "model-call-failed", message: (err as Error).message };
      yield { type: "turn_end", reason: "error" };
      return;
    }

    // Surface usage (if any) before the assistant text so the UI can attach token counts
    // to the upcoming turn.
    if (modelResponse.usage) {
      yield {
        type: "model_usage",
        turn,
        usage: modelResponse.usage,
        ...(modelResponse.profileId ? { profileId: modelResponse.profileId } : {}),
      };
    }
    // ── Parse for tool calls FIRST so we can emit narrative text without raw XML ──
    // Weak local models emit `<tool_name>...</tool_name>` blocks inline with their prose.
    // We must strip those before surfacing `assistant_text` so the chat UI doesn't render
    // the raw XML to the user. Tool calls are emitted later as their own `tool_call` events.
    const parsed = parseAgentResponse(modelResponse.text, knownToolNames);

    // Surface the narrative (XML-stripped) text so the UI shows only the prose.
    if (parsed.narrativeText && parsed.narrativeText.trim().length > 0) {
      yield { type: "assistant_text", text: parsed.narrativeText };
    }

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

    // ── No tool calls → maybe stalled; retry once with forced tool_choice ──
    if (allCalls.length === 0) {
      const shouldForce = (forceEditMode || editIntent) && !autoForceUsed && turn < maxTurns;
      if (shouldForce) {
        autoForceUsed = true;
        forceToolThisTurn = true;
        // Nudge: append a user message explaining that we expect a tool call this time.
        messages.push({
          role: "user",
          content:
            "You did not call any tool. The user is asking for an actual code change — " +
            "use write_file, apply_diff, or search_and_replace now. Do not describe — execute.",
        });
        continue; // re-enter the loop without emitting turn_end
      }
      yield { type: "turn_end", reason: "no_tool_calls" };
      return;
    }
    // We did get tool calls this turn — reset the forced-turn flag so subsequent normal
    // turns don't carry the restricted toolset.
    forceToolThisTurn = false;

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

      // Git checkpoint — for destructive tools, snapshot the working tree first. Best-effort:
      // failures (no git, permission, etc.) are silently ignored so they never block the loop.
      if (DESTRUCTIVE_TOOLS.has(call.name)) {
        const ref = await createGitCheckpoint(ctx.cwd, call.name);
        if (ref) yield { type: "assistant_text", text: `[checkpoint] ${ref} — restore with: git checkout ${ref} -- <path>` };
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

/**
 * In-place mutates `messages`: keeps the first 2 messages (system + initial user) plus the
 * last `keepTail` messages verbatim. Older `tool` messages with large content are replaced
 * by a 1-line summary so the conversation stays within reasonable context budget across
 * long multi-turn sessions.
 *
 * Why only tool messages: assistant narrative is small and helps the model maintain its
 * plan; user messages are rare and load-bearing; tool messages are where bytes accumulate.
 */
function compressOldToolResults(messages: AgentMessage[], keepTail: number): void {
  const tailStart = Math.max(2, messages.length - keepTail);
  for (let i = 2; i < tailStart; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.content.length > 240) {
      const firstLine = m.content.split(/\r?\n/, 1)[0] ?? "";
      const elided = m.content.length - firstLine.length;
      m.content = `${firstLine}\n[…${elided} bytes elided by history compression…]`;
    }
  }
}

function toWireMessage(m: AgentMessage): {
  role: string;
  content: string | unknown[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
} {
  // User turn with images → encode as OpenAI content-parts array (image_url with data: URLs).
  // The daemon's openai-compat layer parses those back out into ChatMessage.images and the
  // provider client maps them to its native vision format. This way the agent and the daemon
  // only have to know the OpenAI dialect.
  if (m.role === "user" && m.images && m.images.length > 0) {
    const parts: unknown[] = m.images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
    }));
    if (m.content && m.content.length > 0) parts.push({ type: "text", text: m.content });
    return { role: m.role, content: parts };
  }
  const out: {
    role: string;
    content: string | unknown[];
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
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
      }),
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`tierkit daemon HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      error?: { message: string; code?: string };
      model?: string;
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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
    const usage = body.usage
      ? {
          promptTokens: body.usage.prompt_tokens ?? 0,
          completionTokens: body.usage.completion_tokens ?? 0,
          totalTokens: body.usage.total_tokens ?? (body.usage.prompt_tokens ?? 0) + (body.usage.completion_tokens ?? 0),
        }
      : undefined;
    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
      ...(body.model ? { profileId: body.model } : {}),
    };
  };
}

/**
 * Default streaming model caller. POSTs to Tierkit's openai-compat endpoint with
 * `stream: true` and parses the SSE chunks. Yields one `chunk` event per non-empty
 * delta, then a `done` event with the accumulated text + parsed tool_calls + usage.
 *
 * Note: when openaiCompat streams, it only tries the FIRST viable candidate (switching
 * mid-stream isn't supported). So streaming sacrifices the auto-fallback behavior that
 * non-streaming gets. The error path here triggers AgentLoop to fall back to the
 * non-streaming callModel — which DOES walk candidates — so we still recover on hard
 * failures (just without streaming UX).
 */
function makeDefaultStreamModel(tierkitBaseUrl: string) {
  return async function* defaultStreamModel(req: ModelCallRequest): AsyncIterable<ModelStreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${tierkitBaseUrl}/v1/openai/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "text/event-stream" },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          ...(req.tools ? { tools: req.tools } : {}),
          ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
        }),
      });
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: "error", message: `tierkit daemon HTTP ${res.status}` };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullText = "";
    const toolCallBuffers: Record<number, { id?: string; name?: string; arguments: string }> = {};
    let usage: ModelCallResponse["usage"] | undefined;
    let profileId: string | undefined;

    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!block.startsWith("data:")) continue;
          const payload = block.slice(5).trim();
          if (payload === "[DONE]") {
            const tcs = Object.values(toolCallBuffers).filter((tc) => tc.name).map((tc) => {
              let args: Record<string, unknown> = {};
              try {
                const parsed = JSON.parse(tc.arguments || "{}");
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  args = parsed as Record<string, unknown>;
                }
              } catch { /* empty */ }
              return { id: tc.id ?? `call_${Date.now().toString(36)}`, name: tc.name!, args };
            });
            yield {
              type: "done",
              response: {
                text: fullText,
                ...(tcs.length > 0 ? { toolCalls: tcs } : {}),
                ...(usage ? { usage } : {}),
                ...(profileId ? { profileId } : {}),
              },
            };
            return;
          }
          try {
            const chunk = JSON.parse(payload) as {
              model?: string;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
                };
              }>;
            };
            if (chunk.model && !profileId) profileId = chunk.model;
            if (chunk.usage) {
              usage = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                totalTokens:
                  chunk.usage.total_tokens
                  ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
              };
            }
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              fullText += delta.content;
              yield { type: "chunk", text: delta.content };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const buf2 = toolCallBuffers[tc.index] ?? { arguments: "" };
                if (tc.id) buf2.id = tc.id;
                if (tc.function?.name) buf2.name = tc.function.name;
                if (tc.function?.arguments) buf2.arguments += tc.function.arguments;
                toolCallBuffers[tc.index] = buf2;
              }
            }
          } catch { /* skip malformed chunk */ }
        }
      }
    } finally {
      try { reader.cancel(); } catch { /* ignore */ }
    }
    // Stream ended without [DONE] — emit done with whatever we collected.
    yield {
      type: "done",
      response: {
        text: fullText,
        ...(usage ? { usage } : {}),
        ...(profileId ? { profileId } : {}),
      },
    };
  };
}

/**
 * Convert Tierkit's ToolParam[] declaration into an OpenAI-shape JSON Schema object.
 * Used only on force-tool-call turns, so the model can be told exactly what shape
 * `arguments` should be when we set tool_choice: "required". The provider that ultimately
 * fields this (Anthropic / OpenAI / Gemini-openai-compat / Ollama-via-format) all
 * understand standard JSON Schema for the parameter object.
 */
function toolParamsToJsonSchema(
  params: Array<{ name: string; type: string; description: string; required?: boolean }>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = { type: p.type, description: p.description };
    if (p.required === true) required.push(p.name);
  }
  return { type: "object", properties, required };
}
