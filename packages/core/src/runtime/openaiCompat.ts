/**
 * OpenAI-compatible inbound HTTP shim.
 *
 * Why: Roo Code, Cline, and most "bring-your-own-model" coding agents speak the OpenAI
 * Chat Completions wire format. Exposing this endpoint on Tierkit means any of those tools
 * can be configured to point at `http://127.0.0.1:4101/v1/openai/chat/completions` and
 * automatically gain Tierkit's policy stack: routing, secret redaction, command-gate,
 * budget enforcement, workflow session gate, usage log.
 *
 * The `model` field from the incoming request is interpreted as a Tierkit profile id
 * (e.g., "localCoder", "claudeSonnet"). The magic value `auto` delegates to `resolveAutoCandidates`
 * to pick and rank profiles based on task content, viability, and budget state.
 *
 * Streaming uses SSE in the OpenAI delta format. Tools that disable streaming get a single
 * JSON response. Errors map to OpenAI's `{error: {message, type, code}}` envelope so caller
 * UIs render them in their native error path.
 */
import type http from "node:http";
import { executeLlmCall, type LlmCallRequest } from "./proxy/llmCall.js";
import type { ToolCall, ToolDefinition, ToolChoice, ChatMessage } from "../model/providers/chatTypes.js";

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Vision input — extracted from image_url content parts during request parsing. */
  images?: { mediaType: string; base64: string }[];
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

export interface OpenAICompatContext {
  cwd: string;
  env: Record<string, string | undefined>;
}

export async function handleOpenAIChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
  context: OpenAICompatContext,
): Promise<void> {
  const parsed = parseRequest(body);
  if (!parsed.ok) {
    return sendError(res, 400, parsed.message, "invalid_request_error");
  }
  const { request: req2 } = parsed;

  // ── Resolve profile (explicit id, or "auto" via the shared resolver) ─────
  const isAuto = req2.model === "auto" || req2.model === "tierkit";
  let candidateIds: string[];
  let autoTaskType: string | undefined;
  if (isAuto) {
    const lastUserMsg = [...req2.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    try {
      const { resolveAutoCandidates } = await import("./proxy/autoResolver.js");
      const resolved = await resolveAutoCandidates({
        cwd: context.cwd,
        env: context.env,
        lastUserMessage: typeof lastUserMsg === "string" ? lastUserMsg : "",
      });
      candidateIds = resolved.candidateIds;
      autoTaskType = resolved.taskType;
      if (candidateIds.length === 0) {
        return sendError(res, 400, "auto-route: no profile matched", "invalid_request_error");
      }
    } catch (err) {
      return sendError(res, 400, `auto-route failed: ${(err as Error).message}`, "invalid_request_error");
    }
  } else {
    candidateIds = [req2.model];

    // v0.13: pinned profiles do not silently fall back. Validate up front and emit
    // a clear error if the profile is missing, disabled, or non-viable.
    const { loadConfig } = await import("../config/loadConfig.js");
    const cfg = await loadConfig(context.cwd);
    const profile = cfg.config.modelProfiles[req2.model];
    if (!profile) {
      return sendError(res, 404, `unknown profile: ${req2.model}`, "invalid_request_error", {
        profileId: req2.model,
      });
    }
    if ((cfg.config.disabledProfileIds ?? []).includes(req2.model)) {
      return sendError(res, 409, `profile is disabled: ${req2.model}`, "profile_disabled", {
        profileId: req2.model,
        reason: "profile-disabled",
      });
    }
    const { checkProfileViability } = await import("../model/profileViability.js");
    const v = await checkProfileViability(profile, context.env);
    if (!v.viable) {
      return sendError(
        res,
        502,
        viabilityMessage(req2.model, v.reason!),
        "profile_not_viable",
        { profileId: req2.model, reason: v.reason },
      );
    }
  }
  void autoTaskType; // will be used by Phase 2b activity log

  const baseLlmReq = {
    // ChatMessage keeps the "tool" role distinct (Anthropic needs it to build tool_result
    // blocks; Ollama/OpenAI use it natively too). The earlier hack of remapping tool→user
    // is removed now that downstream provider clients understand it.
    messages: req2.messages.map((m): ChatMessage => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
    })),
    ...(req2.max_tokens !== undefined ? { maxTokens: req2.max_tokens } : {}),
    ...(req2.temperature !== undefined ? { temperature: req2.temperature } : {}),
    ...(req2.tools !== undefined ? { tools: req2.tools } : {}),
    ...(req2.toolChoice !== undefined ? { toolChoice: req2.toolChoice } : {}),
  };

  if (req2.stream) {
    // For streaming we only try the first candidate — switching mid-stream is hairy.
    // If auto's first pick fails for streaming clients, they'll get the error in-band.
    const firstId = candidateIds[0]!;

    // Subprocess providers (e.g. claude-code) don't support native streaming in v0.13.
    // Load config to inspect the first candidate's transport type. loadConfig is cheap
    // (cached) so re-calling it here doesn't add meaningful latency.
    const { loadConfig: loadCfgForStream } = await import("../config/loadConfig.js");
    const cfgForStream = await loadCfgForStream(context.cwd);
    const firstProfile = cfgForStream.config.modelProfiles[firstId];
    const isSubprocess = firstProfile?.transport?.type === "subprocess";

    if (isSubprocess) {
      await streamDegradedResponse(res, { profileId: firstId, ...baseLlmReq }, context, firstId);
      return;
    }
    await streamResponse(res, { profileId: firstId, ...baseLlmReq }, context, firstId);
    return;
  }

  // Non-streaming: walk candidates, fall back on transient OR quality failures (auto only).
  const cfgForQuality = isAuto ? await (await import("../config/loadConfig.js")).loadConfig(context.cwd) : undefined;
  const qualityCheckOn = isAuto && cfgForQuality?.config.routingPolicy.responseQualityCheck !== false;
  const lastUserMsgForQuality = qualityCheckOn
    ? (typeof [...req2.messages].reverse().find((m) => m.role === "user")?.content === "string"
        ? ([...req2.messages].reverse().find((m) => m.role === "user")?.content as string)
        : "")
    : "";

  const attempts: { profileId: string; code: string; message: string }[] = [];
  let result: Awaited<ReturnType<typeof executeLlmCall>> | undefined;
  for (const candidate of candidateIds) {
    result = await executeLlmCall({ profileId: candidate, ...baseLlmReq }, { cwd: context.cwd, env: context.env });
    if (result.ok) {
      if (qualityCheckOn) {
        const { evaluateResponse } = await import("../model/ResponseQualityEvaluator.js");
        const verdict = evaluateResponse(result.text, result.finishReason, lastUserMsgForQuality);
        if (!verdict.acceptable) {
          attempts.push({ profileId: candidate, code: `quality-rejected:${verdict.reason}`, message: `response rejected by quality check (${verdict.reason})` });
          continue;
        }
      }
      break;
    }
    if (!isTransientFailure(result.code)) break;
    attempts.push({ profileId: candidate, code: result.code, message: result.message });
  }
  if (!result || !result.ok) {
    const final = result ?? { ok: false as const, code: "no-candidates", message: "no candidates tried" };
    const detail = attempts.length > 0
      ? ` (tried ${attempts.length + 1}: ${attempts.map((a) => `${a.profileId}=${a.code}`).join(", ")}${attempts.length + 1 > attempts.length ? `, last=${final.code !== "no-candidates" ? final.code : "?"}` : ""})`
      : "";
    return sendError(res, 400, final.message + detail, mapErrorType(final.code), { code: final.code });
  }

  const completionId = "chatcmpl-" + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);
  // OpenAI's contract: when tool_calls are present, content may be null. We preserve text
  // if the model produced both (some models narrate before calling a tool).
  const finishReason = result.finishReason ?? (result.toolCalls && result.toolCalls.length > 0 ? "tool_calls" : "stop");
  const responseBody = {
    id: completionId,
    object: "chat.completion",
    created,
    model: result.model || candidateIds[0],
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          // OpenAI's contract: content is null ONLY when tool_calls is present without any
          // narration. Without tool_calls, return a string (empty if no text) — many
          // clients (older OpenAI SDKs, simple curl scripts) expect string-typed content.
          content:
            result.toolCalls && result.toolCalls.length > 0 && !result.text
              ? null
              : (result.text ?? ""),
          ...(result.toolCalls && result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
    },
    // Tierkit policy disclosures — non-standard but harmless for OpenAI-compatible clients
    // that ignore unknown fields. Surfaces routing/redaction info to whoever wants it.
    tierkit: {
      profileId: result.profileId,
      tier: result.model,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      redactionHits: result.redactionHits,
      budget: result.budget,
      // If we fell back from one or more failing profiles, surface them so the caller can
      // see what was tried before success.
      ...(attempts.length > 0
        ? {
            fallback: {
              attempts: attempts.map((a) => ({ profileId: a.profileId, code: a.code })),
              chosen: result.profileId,
            },
          }
        : {}),
    },
  };
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(responseBody));
}

async function streamResponse(
  res: http.ServerResponse,
  llmReq: LlmCallRequest,
  context: OpenAICompatContext,
  profileId: string,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-store");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const completionId = "chatcmpl-" + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);

  function send(obj: unknown): void {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  // Today /v1/llm-call returns one buffered response. Emit it as a single delta chunk
  // wrapped in OpenAI's SSE shape so streaming clients (Cline et al.) accept it. Once
  // `executeLlmCall` exposes a streaming path we'll switch to per-token chunks here.
  const result = await executeLlmCall(llmReq, { cwd: context.cwd, env: context.env });

  // First chunk: role assignment (matches OpenAI's convention so clients render the
  // assistant bubble before the first text chunk arrives).
  send({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: (result.ok && result.model) || profileId,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  if (!result.ok) {
    send({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: profileId,
      choices: [{ index: 0, delta: { content: `\n[${result.code}] ${result.message}` }, finish_reason: "stop" }],
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  send({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: result.model || profileId,
    choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
  });
  send({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: result.model || profileId,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
    },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Synthesise a valid OpenAI SSE stream from a single buffered `executeLlmCall` result.
 *
 * Used when the selected profile uses a subprocess transport (e.g. claude-code). These
 * providers do not support native token streaming in v0.13, so we collect the full
 * response and emit it as a three-chunk SSE sequence.  Both the first (role) chunk and
 * the final (usage + finish) chunk carry a `tierkit.warning: "stream-degraded-to-non-stream"`
 * field so callers can detect the behaviour and log/surface it as appropriate.
 */
async function streamDegradedResponse(
  res: http.ServerResponse,
  llmReq: LlmCallRequest,
  context: OpenAICompatContext,
  profileId: string,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const result = await executeLlmCall(llmReq, { cwd: context.cwd, env: context.env });
  const created = Math.floor(Date.now() / 1000);
  const cmplId = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;

  const tierkitWarning = "stream-degraded-to-non-stream" as const;

  if (!result.ok) {
    // Emit a single error chunk so the client gets an in-band signal, then DONE.
    res.write(`data: ${JSON.stringify({
      id: cmplId,
      object: "chat.completion.chunk",
      created,
      model: profileId,
      choices: [],
      tierkit: {
        profileId,
        warning: tierkitWarning,
        error: result.code,
      },
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const tierkitMeta = {
    profileId,
    warning: tierkitWarning,
  };

  // Chunk 1: role assignment + warning envelope (matches OpenAI's convention of sending
  // a role-only delta before the first content delta).
  res.write(`data: ${JSON.stringify({
    id: cmplId,
    object: "chat.completion.chunk",
    created,
    model: result.model || profileId,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    tierkit: tierkitMeta,
  })}\n\n`);

  // Chunk 2: single content delta (no tierkit envelope — middle chunks stay lean).
  res.write(`data: ${JSON.stringify({
    id: cmplId,
    object: "chat.completion.chunk",
    created,
    model: result.model || profileId,
    choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
  })}\n\n`);

  // Chunk 3: finish + usage + warning envelope (lets callers correlate usage with the
  // degraded-stream warning without having to inspect chunk 1).
  res.write(`data: ${JSON.stringify({
    id: cmplId,
    object: "chat.completion.chunk",
    created,
    model: result.model || profileId,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
    },
    tierkit: tierkitMeta,
  })}\n\n`);

  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * OpenAI's chat completions API accepts `message.content` in two forms:
 *   - a plain string ("hi")
 *   - an array of content parts: [{ type: "text", text: "hi" }, { type: "image_url", ... }]
 *
 * Roo Code (and most modern OpenAI-compatible clients) send the array form even for plain
 * text because they want the option to add images / tool results later. Tierkit forwards
 * to its underlying providers (Ollama/Anthropic/OpenAI) which expect plain strings, so we
 * concatenate any text parts and drop unknown parts (image_url, tool_use, etc.) silently.
 *
 * Returns `null` if the input is neither a string nor an array of content parts.
 */
interface FlattenResult {
  text: string;
  images: { mediaType: string; base64: string }[];
}

function flattenContent(value: unknown): FlattenResult | null {
  if (typeof value === "string") return { text: value, images: [] };
  if (value === undefined || value === null) return { text: "", images: [] };
  if (Array.isArray(value)) {
    const parts: string[] = [];
    const images: { mediaType: string; base64: string }[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        // OpenAI text part: { type: "text", text: "..." }
        if (obj.type === "text" && typeof obj.text === "string") {
          parts.push(obj.text);
        }
        // OpenAI image part: { type: "image_url", image_url: { url: "data:image/png;base64,..." | "https://..." } }
        else if (obj.type === "image_url" && obj.image_url) {
          const iu = obj.image_url as Record<string, unknown> | string;
          const url = typeof iu === "string" ? iu : typeof iu.url === "string" ? iu.url : "";
          const parsed = parseDataUrl(url);
          if (parsed) images.push(parsed);
          // http(s) URLs are intentionally dropped — fetching arbitrary URLs from the
          // daemon is a SSRF surface; clients must inline base64 if they want vision.
        }
        // Anthropic-style image part: { type: "image", source: { type: "base64", media_type, data } }
        else if (obj.type === "image" && obj.source && typeof obj.source === "object") {
          const src = obj.source as Record<string, unknown>;
          if (src.type === "base64" && typeof src.media_type === "string" && typeof src.data === "string") {
            images.push({ mediaType: src.media_type, base64: src.data });
          }
        }
        // Anthropic-style tool_result might pass through some clients
        else if (obj.type === "tool_result" && typeof obj.content === "string") {
          parts.push(obj.content);
        }
        // Plain content with text field (some clients)
        else if (typeof obj.text === "string" && !obj.type) {
          parts.push(obj.text);
        }
      }
    }
    return { text: parts.join("\n"), images };
  }
  return null;
}

function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(url);
  if (!m) return null;
  return { mediaType: m[1]!, base64: m[2]! };
}

function parseRequest(body: unknown):
  | { ok: true; request: OpenAIChatRequest }
  | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || b.model.length === 0) {
    return {
      ok: false,
      message: "field `model` is required (set to a Tierkit profile id, or `auto` to auto-route)",
    };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, message: "field `messages` is required and must be a non-empty array" };
  }
  const messages: OpenAIChatMessage[] = [];
  for (const m of b.messages as Array<Record<string, unknown>>) {
    if (!m || typeof m !== "object") return { ok: false, message: "each message must be an object" };
    const role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      return { ok: false, message: `unknown role: ${String(role)}` };
    }
    const flattened = flattenContent(m.content);
    if (flattened === null) {
      return {
        ok: false,
        message:
          "each message.content must be a string OR an array of OpenAI content parts " +
          "({ type: 'text', text: '...' } or { type: 'image_url', image_url: { url: 'data:...;base64,...' } }).",
      };
    }
    const parsed: OpenAIChatMessage = { role, content: flattened.text };
    if (flattened.images.length > 0 && role === "user") parsed.images = flattened.images;
    // OpenAI's assistant turn can have either content, tool_calls, or both. Accept whatever
    // the caller sends — we forward to the provider client which knows its own format.
    if (role === "assistant" && Array.isArray((m as Record<string, unknown>).tool_calls)) {
      const tcs = (m as { tool_calls: unknown[] }).tool_calls;
      const parsedToolCalls: ToolCall[] = [];
      for (const tc of tcs) {
        if (tc && typeof tc === "object") {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          if (typeof t.id === "string" && fn && typeof fn.name === "string") {
            parsedToolCalls.push({
              id: t.id,
              type: "function",
              function: {
                name: fn.name,
                arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
              },
            });
          }
        }
      }
      if (parsedToolCalls.length > 0) parsed.toolCalls = parsedToolCalls;
    }
    if (role === "tool" && typeof (m as Record<string, unknown>).tool_call_id === "string") {
      parsed.toolCallId = (m as { tool_call_id: string }).tool_call_id;
    }
    messages.push(parsed);
  }
  const request: OpenAIChatRequest = { model: b.model as string, messages };
  if (typeof b.temperature === "number") request.temperature = b.temperature;
  if (typeof b.max_tokens === "number") request.max_tokens = b.max_tokens;
  if (typeof b.stream === "boolean") request.stream = b.stream;
  // Tools: array of { type: "function", function: { name, description?, parameters? } }.
  // We do minimal validation — the provider clients will reject obviously-malformed shapes.
  if (Array.isArray(b.tools)) {
    const tools: ToolDefinition[] = [];
    for (const t of b.tools) {
      if (t && typeof t === "object") {
        const fn = (t as Record<string, unknown>).function as Record<string, unknown> | undefined;
        if (fn && typeof fn.name === "string") {
          tools.push({
            type: "function",
            function: {
              name: fn.name,
              ...(typeof fn.description === "string" ? { description: fn.description } : {}),
              ...(fn.parameters && typeof fn.parameters === "object"
                ? { parameters: fn.parameters as Record<string, unknown> }
                : {}),
            },
          });
        }
      }
    }
    if (tools.length > 0) request.tools = tools;
  }
  // tool_choice: "auto" | "none" | "required" | { type: "function", function: { name } }
  if (typeof b.tool_choice === "string" && (b.tool_choice === "auto" || b.tool_choice === "none" || b.tool_choice === "required")) {
    request.toolChoice = b.tool_choice;
  } else if (b.tool_choice && typeof b.tool_choice === "object") {
    const tc = b.tool_choice as Record<string, unknown>;
    const fn = tc.function as Record<string, unknown> | undefined;
    if (tc.type === "function" && fn && typeof fn.name === "string") {
      request.toolChoice = { type: "function", function: { name: fn.name } };
    }
  }
  return { ok: true, request };
}

function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
  type: string,
  meta?: { code?: string; profileId?: string; reason?: string },
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      error: {
        message,
        type,
        ...(meta?.code ? { code: meta.code } : {}),
        ...(meta?.profileId ? { profileId: meta.profileId } : {}),
        ...(meta?.reason ? { reason: meta.reason } : {}),
      },
    }),
  );
}

function viabilityMessage(profileId: string, reason: string): string {
  switch (reason) {
    case "cli-not-found":
      return `${profileId}: CLI not found on PATH. Install the CLI, fix transport.command, or use model:"auto" to allow fallback routing.`;
    case "cli-healthcheck-failed":
      return `${profileId}: CLI healthcheck failed. Verify the CLI is logged in and runnable, or use model:"auto".`;
    case "missing-api-key":
      return `${profileId}: required API key env var is not set. Set the apiKeyEnv variable or use model:"auto".`;
    case "ollama-unreachable":
      return `${profileId}: Ollama is unreachable. Start Ollama or use model:"auto".`;
    case "model-not-installed":
      return `${profileId}: configured model is not installed. Pull the model or use model:"auto".`;
    default:
      return `${profileId}: not viable (${reason})`;
  }
}

function mapErrorType(code: string): string {
  if (code === "unknown-profile") return "invalid_request_error";
  if (code === "missing-api-key" || code === "unauthorized") return "authentication_error";
  if (code === "budget-exceeded") return "rate_limit_error";
  if (code === "dangerous-command-blocked" || code === "plan-not-approved") return "permission_error";
  return "api_error";
}

/**
 * `auto` route fallback only kicks in for failures that mean "this profile cannot be used
 * right now", not for policy decisions or actual user errors. We want to keep trying
 * profiles when:
 *   - the upstream provider is unreachable (Ollama not running, OpenAI down, etc.)
 *   - the upstream returned a bad status (model not pulled, deprecated model id)
 *   - the API key for this profile is missing (try a profile that has one)
 *   - the profile's provider has no client implementation in this Tierkit version
 *
 * We do NOT retry on policy or input errors — those are correct, intentional refusals:
 *   - dangerous-command-blocked / plan-not-approved → user must change their input
 *   - budget-exceeded → user must change their budget
 *   - unknown-profile → config issue, retrying won't help
 *   - invalid-state / session-closed → workflow gate worked as designed
 */
function isTransientFailure(code: string): boolean {
  return (
    code === "unreachable" ||
    code === "bad-status" ||
    code === "missing-api-key" ||
    code === "not-implemented" ||
    code === "network-error" ||
    code === "timeout"
  );
}
