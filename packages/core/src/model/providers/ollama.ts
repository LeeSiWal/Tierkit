import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, StreamEvent } from "./chatTypes.js";
import { iterNDJSON } from "./streamUtils.js";

interface OllamaTagsResponse {
  models?: { name: string }[];
}

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaStreamChunk {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

function isConnectionRefused(err: Error): boolean {
  return /ECONNREFUSED|fetch failed|connect ENOENT/i.test(err.message);
}

function friendlyOllamaUnreachable(baseUrl: string, err: Error): string {
  if (isConnectionRefused(err)) {
    return `cannot reach ollama at ${baseUrl} — is the daemon running? Try: ollama serve`;
  }
  return `cannot reach ollama at ${baseUrl}: ${err.message}`;
}

/**
 * Ollama probe: `GET {baseUrl}/api/tags` returns the list of locally-installed models.
 * No auth required for the default Ollama install. We additionally check whether the
 * profile's configured model appears in the returned list and report it via `modelAvailable`.
 */
export class OllamaClient implements ProviderClient {
  async probe(profile: ModelProfile): Promise<ProbeResult> {
    if (!profile.baseUrl) {
      return { ok: false, code: "missing-base-url", message: "ollama profile requires baseUrl", latencyMs: 0 };
    }
    const url = joinUrl(profile.baseUrl, "/api/tags");
    const start = performance.now();
    try {
      const res = await fetch(url, { method: "GET" });
      const latencyMs = Math.round(performance.now() - start);
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `ollama responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const body = (await res.json()) as OllamaTagsResponse;
      const models = body.models ?? [];
      const modelCount = models.length;
      const modelAvailable = models.some((m) => m.name === profile.model || m.name.startsWith(profile.model + ":"));
      return {
        ok: true,
        modelCount,
        modelAvailable,
        latencyMs,
        note: modelAvailable
          ? `model "${profile.model}" is installed (${modelCount} total)`
          : `${modelCount} model(s) installed but "${profile.model}" is NOT one of them — run \`ollama pull ${profile.model}\``,
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: friendlyOllamaUnreachable(profile.baseUrl, err as Error),
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async chat(profile: ModelProfile, request: ChatRequest): Promise<ChatResult> {
    if (!profile.baseUrl) {
      return {
        ok: false,
        code: "missing-base-url",
        message: "ollama profile requires baseUrl",
        latencyMs: 0,
      };
    }
    const url = joinUrl(profile.baseUrl, "/api/chat");
    const body = {
      model: profile.model,
      messages: request.messages,
      stream: false,
      ...(request.maxTokens !== undefined || request.temperature !== undefined
        ? {
            options: {
              ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
          }
        : {}),
    };
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const latencyMs = Math.round(performance.now() - start);
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `ollama responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const parsed = (await res.json()) as OllamaChatResponse;
      const text = parsed.message?.content ?? "";
      return {
        ok: true,
        text,
        usage: {
          inputTokens: parsed.prompt_eval_count ?? 0,
          outputTokens: parsed.eval_count ?? 0,
        },
        latencyMs,
        model: profile.model,
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: friendlyOllamaUnreachable(profile.baseUrl, err as Error),
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async *stream(profile: ModelProfile, request: ChatRequest): AsyncIterable<StreamEvent> {
    if (!profile.baseUrl) {
      yield {
        type: "error",
        code: "missing-base-url",
        message: "ollama profile requires baseUrl",
        latencyMs: 0,
      };
      return;
    }
    yield { type: "start", model: profile.model, provider: "ollama" };
    const url = joinUrl(profile.baseUrl, "/api/chat");
    const body = {
      model: profile.model,
      messages: request.messages,
      stream: true,
      ...(request.maxTokens !== undefined || request.temperature !== undefined
        ? {
            options: {
              ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
          }
        : {}),
    };
    const start = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield {
        type: "error",
        code: "unreachable",
        message: friendlyOllamaUnreachable(profile.baseUrl, err as Error),
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }
    if (!res.ok) {
      yield {
        type: "error",
        code: "bad-status",
        message: `ollama responded with ${res.status} ${res.statusText}`,
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }

    let promptTokens: number | undefined;
    let evalTokens: number | undefined;
    try {
      for await (const chunk of iterNDJSON<OllamaStreamChunk>(res.body)) {
        const delta = chunk.message?.content ?? "";
        if (delta.length > 0) yield { type: "delta", text: delta };
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count;
          evalTokens = chunk.eval_count;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        code: "stream-error",
        message: `ollama stream broke mid-flight: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }

    if (promptTokens !== undefined || evalTokens !== undefined) {
      yield {
        type: "usage",
        ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
        ...(evalTokens !== undefined ? { outputTokens: evalTokens } : {}),
      };
    }
    yield { type: "end", latencyMs: Math.round(performance.now() - start) };
  }
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/")) return base.slice(0, -1) + path;
  return base + path;
}
