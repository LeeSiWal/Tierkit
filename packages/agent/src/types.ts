/**
 * Type definitions for `@tierkit/agent` — Tierkit's built-in coding agent.
 *
 * The agent is a stateful conversation between the user and a model, with the model
 * driving file/shell operations through a set of well-typed tools. Every model call goes
 * through Tierkit's `/v1/openai/chat/completions` endpoint, so all of Tierkit's policy
 * gates (routing, viability, secret redaction, command-gate, budget, sessions, plugin
 * rules) apply automatically.
 *
 * Tool format follows Cline / Roo Code's XML-tag convention because:
 *   - models follow it more reliably than OpenAI structured tool_calls (especially smaller
 *     local Ollama models — see Tierkit 0.3.3's tool-shim background)
 *   - it's the format Roo's system prompt teaches by example, so we can reuse the same
 *     patterns when caller-supplied tools (Roo passthrough) coexist with the agent's
 *     own tools
 */

/** A chat message in the agent's conversation history. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on `assistant` messages that contain tool invocations. */
  toolCalls?: AgentToolCall[];
  /** Set on `tool` messages — links back to the invocation that produced this result. */
  toolCallId?: string;
  /** Set on `user` messages with vision attachments. */
  images?: { mediaType: string; base64: string }[];
}

/** A single tool invocation requested by the model. */
export interface AgentToolCall {
  id: string;
  name: string;
  /** Tool-specific argument map. JSON-serializable. */
  args: Record<string, unknown>;
}

/** Result of executing a tool invocation. Always serialized as a string for the model. */
export interface ToolResult {
  ok: boolean;
  content: string;
  /** Set when `ok === false`. */
  error?: { code: string; message: string };
}

/** A tool the agent can invoke. Implementations live in `src/tools/`. */
export interface Tool {
  /** Lowercase identifier, used in XML tags and tool_call.name. */
  name: string;
  /** Short human-readable description; included in the system prompt. */
  description: string;
  /** Per-parameter spec for the system prompt. */
  parameters: ToolParam[];
  /** Optional concrete usage example in the system prompt. */
  example?: string;
  /**
   * Whether this tool needs user approval before execution. Defaults to false. Approval
   * is delivered by the runtime (sidebar shows an Approve/Reject button); the tool itself
   * just declares its risk level here.
   */
  approval?: "always" | "destructive-only" | "never";
  /** Execute the tool with caller-supplied args. */
  execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult>;
}

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required?: boolean;
}

/** Context passed into every tool invocation. */
export interface AgentContext {
  /** Workspace root — every file path is resolved relative to this. */
  cwd: string;
  /** Environment variables visible to executed commands. */
  env: Record<string, string | undefined>;
  /**
   * Tierkit daemon base URL. Tools that need to consult Tierkit policy (e.g. command
   * classification) hit this endpoint rather than calling Tierkit core directly — keeps
   * the agent decoupled from Tierkit's internal API.
   */
  tierkitBaseUrl: string;
  /**
   * Optional approval handler. When a tool's `approval` is non-"never", the runtime
   * calls this to gate the call. Returning false aborts the tool with a `denied` result.
   * If `undefined`, default behavior is "auto-approve" (suited for headless / test runs).
   */
  approve?: (toolCall: AgentToolCall) => Promise<boolean>;
  /**
   * Optional cancellation signal. Long-running tools (execute_command, search_files, etc.)
   * should check this and abort cleanly. The daemon-side route wires this to the HTTP
   * request's `close` event so clicking Stop in the sidebar aborts in-flight commands.
   */
  abortSignal?: AbortSignal;
}

/**
 * Events emitted by the agent loop. The runtime renders these in the sidebar / streams
 * them to /v1/agent/run callers. Each event marks a discrete moment in the conversation.
 */
export type AgentEvent =
  | { type: "task_start"; taskId: string; task: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "model_usage";
      turn: number;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      profileId?: string;
    }
  | { type: "tool_call"; call: AgentToolCall }
  | { type: "tool_approval_pending"; call: AgentToolCall }
  | { type: "tool_approval_resolved"; call: AgentToolCall; approved: boolean }
  | { type: "tool_result"; call: AgentToolCall; result: ToolResult }
  | { type: "turn_end"; reason: "no_tool_calls" | "max_turns" | "user_abort" | "error" }
  | { type: "task_complete"; taskId: string; turnCount: number }
  | { type: "error"; code: string; message: string };

/** Input to `runAgent`. */
export interface AgentRunInput {
  task: string;
  /**
   * Which Tierkit profile id to call. Defaults to `"auto"` so Tierkit's router picks
   * based on task risk + viability.
   */
  modelId?: string;
  /** Workspace root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override env passed to tools. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Plugin/mode name to derive tool whitelist + system prompt rules from. When omitted,
   * all registered tools are exposed and only the per-plugin rules from
   * `runtime.injectPluginRules` apply (no mode-specific subset).
   */
  mode?: string;
  /** Tierkit daemon URL. Defaults to `http://127.0.0.1:4101`. */
  tierkitBaseUrl?: string;
  /** Cap on agent turns before giving up. Defaults to 25. */
  maxTurns?: number;
  /**
   * Approval handler for tools with `approval: "always"` (e.g. write_file, execute_command).
   * The agent loop calls this and waits before executing. Returning `false` aborts the
   * specific tool call (the model sees `[denied]` as the tool result). When omitted, all
   * approval-required tools auto-approve — useful in tests; the daemon-side runtime wires
   * a real approval handler that surfaces UI prompts in the sidebar.
   */
  approve?: (toolCall: AgentToolCall) => Promise<boolean>;
  /**
   * How the daemon route handles approval requests when no explicit `approve` is passed.
   *   - `"auto"` (default): auto-approve every tool — fastest, no user interaction
   *   - `"interactive"`: wait for the client to POST /v1/agent/approval before running the tool.
   *     Use this when a UI consumer can respond (e.g. the sidebar). Requests time out after
   *     5 minutes and are auto-denied.
   * Passing both `approve` and `approvalMode` is allowed; `approve` wins.
   */
  approvalMode?: "auto" | "interactive";
  /** Optional abort signal — propagated into tool execution. The daemon route wires this
   * to the HTTP request's `close` event so clicking Stop kills any running execute_command. */
  abortSignal?: AbortSignal;
  /**
   * Optional inline image attachments for the initial user turn (vision input). The agent
   * forwards them to the daemon's openai-compat endpoint, which routes them to the active
   * provider (Anthropic → image block, OpenAI → image_url part). Models without vision
   * support drop attachments silently — choose a vision-capable profile via `modelId`.
   */
  attachments?: ImageAttachment[];
}

export interface ImageAttachment {
  /** MIME type, e.g. "image/png", "image/jpeg", "image/webp". */
  mediaType: string;
  /** Base64-encoded raw bytes (no `data:` URI prefix). */
  base64: string;
}
