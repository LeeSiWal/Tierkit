import type {
  ExplainRouteUsecaseResult,
  CheckCommandResult,
  CheckPathResult,
  RedactionResult,
  BudgetCheckResult,
  UsageRecord,
  LlmCallResult,
  StreamEvent,
  ChatMessage,
  FreedomLevel,
  ExecutionSession,
  SessionState,
  ListModelsResult,
  ListPluginsResult,
} from "@tierkit/core";

export interface TierkitClientOptions {
  /** Base URL of the running runtime daemon. Defaults to http://127.0.0.1:4101. */
  baseUrl?: string;
  /** Fetch implementation override (Node 20+ has global fetch; pass a mock for tests). */
  fetch?: typeof fetch;
  /** Default request timeout in ms (applies to non-streaming endpoints). 0 = no timeout. */
  timeoutMs?: number;
}

export class TierkitClientError extends Error {
  public readonly code: string;
  public readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "TierkitClientError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  cwd: string;
}

export interface RouteExplainRequest {
  task: string;
  filesTouchedEstimate?: number;
  involvesSecrets?: boolean;
  involvesProductionInfra?: boolean;
}

export interface LlmCallRequest {
  profileId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  toolCommands?: string[];
}

export interface UsageResponse {
  records: UsageRecord[];
  summary: {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    byProfile: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>;
  };
}

/**
 * Typed HTTP client for the Tierkit runtime daemon.
 *
 * Usage:
 * ```ts
 * import { TierkitClient } from "@tierkit/client";
 * const client = new TierkitClient(); // defaults to http://127.0.0.1:4101
 * const health = await client.health();
 * const decision = await client.routeExplain({ task: "rename a helper" });
 * for await (const evt of client.llmCallStream({ profileId: "localFast", messages: [...] })) {
 *   if (evt.type === "delta") process.stdout.write(evt.text);
 * }
 * ```
 *
 * `llmCallStream` doesn't currently use SSE wire format because the daemon's `/v1/llm-call`
 * returns a single JSON response after the upstream provider stream completes. A future
 * proxy-streaming endpoint can re-use the same client method — the AsyncIterable contract
 * doesn't change.
 */
export class TierkitClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: TierkitClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:4101").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/v1/health");
  }

  async routeExplain(req: RouteExplainRequest): Promise<ExplainRouteUsecaseResult> {
    return this.post<ExplainRouteUsecaseResult>("/v1/route", req);
  }

  async checkCommand(command: string): Promise<CheckCommandResult> {
    return this.post<CheckCommandResult>("/v1/check/command", { command });
  }

  async checkPath(p: string): Promise<CheckPathResult> {
    return this.post<CheckPathResult>("/v1/check/path", { path: p });
  }

  async redact(text: string): Promise<RedactionResult> {
    return this.post<RedactionResult>("/v1/redact", { text });
  }

  async llmCall(req: LlmCallRequest): Promise<LlmCallResult> {
    return this.post<LlmCallResult>("/v1/llm-call", req);
  }

  /**
   * Yields events as the LLM call progresses. The current daemon implementation returns a
   * single response after the upstream stream completes, so this is effectively a one-shot
   * `start → (one chunk) → end | error`. The shape matches `ProviderClient.stream()` so
   * downstream code can treat live streaming and post-hoc responses identically.
   */
  async *llmCallStream(req: LlmCallRequest): AsyncIterable<StreamEvent> {
    const result = await this.llmCall(req);
    if (!result.ok) {
      yield {
        type: "error",
        code: result.code,
        message: result.message,
        latencyMs: result.latencyMs ?? 0,
      };
      return;
    }
    yield { type: "start", model: result.model, provider: "tierkit-runtime" };
    if (result.text.length > 0) yield { type: "delta", text: result.text };
    yield { type: "usage", inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    yield { type: "end", latencyMs: result.latencyMs };
  }

  async usage(since?: Date): Promise<UsageResponse> {
    const q = since ? `?since=${encodeURIComponent(since.toISOString())}` : "";
    return this.get<UsageResponse>(`/v1/usage${q}`);
  }

  async budget(): Promise<BudgetCheckResult> {
    return this.get<BudgetCheckResult>("/v1/budget");
  }

  // ── v1.5: session, models, plugins ──

  async session(): Promise<{ session: ExecutionSession | null; freedom: FreedomLevel }> {
    return this.get("/v1/session");
  }

  async sessionStart(task: string): Promise<{ session: ExecutionSession; replacedPrevious: boolean }> {
    return this.post("/v1/session/start", { task });
  }

  async sessionApprovePlan(): Promise<ExecutionSession | { code: string; message: string }> {
    return this.post("/v1/session/approve-plan", undefined);
  }

  async sessionAdvance(
    toState: SessionState,
    reason?: string,
  ): Promise<ExecutionSession | { code: string; message: string }> {
    return this.post("/v1/session/advance", { toState, ...(reason ? { reason } : {}) });
  }

  async sessionAbandon(reason?: string): Promise<ExecutionSession | null> {
    return this.post("/v1/session/abandon", reason ? { reason } : {});
  }

  async models(): Promise<ListModelsResult> {
    return this.get("/v1/models");
  }

  async modelsTest(profileId: string): Promise<unknown> {
    return this.post("/v1/models/test", { profileId });
  }

  async plugins(): Promise<ListPluginsResult> {
    return this.get("/v1/plugins");
  }

  // ── v1.8: profile mutation + workspace init ──
  async configAddProfile(args: {
    id: string;
    profile: Record<string, unknown>;
    scope?: "workspace" | "user";
  }): Promise<{ path: string; scope: "workspace" | "user"; id: string }> {
    return this.post("/v1/config/profile", args);
  }

  async configRemoveProfile(
    id: string,
    scope: "workspace" | "user" = "workspace",
  ): Promise<{ path: string; scope: "workspace" | "user"; id: string }> {
    const url = `/v1/config/profile/${encodeURIComponent(id)}?scope=${scope}`;
    return this.request("DELETE", url);
  }

  async configInit(args?: {
    force?: boolean;
    defaultTarget?: "roo" | "zoo" | "cline" | "continue" | "claude-code" | "generic";
  }): Promise<{ projectRoot: string; configPath: string; registryPath: string; created: string[]; skipped: string[] }> {
    return this.post("/v1/config/init", args ?? {});
  }

  // ── v0.2: connect external tools + plugin scaffold/sync ──
  async connections(): Promise<{
    connections: { tool: string; present: boolean; routed: boolean; configPath: string; modelId?: string }[];
  }> {
    return this.get("/v1/connections");
  }

  async pluginEnable(pluginId: string): Promise<{ pluginId: string; activePlugins: string[]; action: string; sync?: unknown }> {
    return this.post("/v1/plugins/enable", { pluginId });
  }

  async pluginDisable(pluginId: string): Promise<{ pluginId: string; activePlugins: string[]; action: string; sync?: unknown }> {
    return this.post("/v1/plugins/disable", { pluginId });
  }

  async connectTool(args: {
    tool: "roo" | "cline" | "continue";
    tierkitBaseUrl?: string;
    defaultProfile?: string;
  }): Promise<{ tool: string; configPath: string; summary: string; followUp?: string }> {
    return this.post("/v1/connect", args);
  }

  async pluginsSync(tools?: Array<"roo" | "cline" | "continue">): Promise<{
    detected: string[];
    synced: { tool: string; target: string; filesWritten: number; warnings: number }[];
    skipped: { tool: string; reason: string }[];
  }> {
    return this.post("/v1/plugins/sync", tools ? { tools } : {});
  }

  async pluginNew(args: {
    id: string;
    name?: string;
    description?: string;
    author?: string;
    force?: boolean;
  }): Promise<{ pluginDir: string; created: string[]; skipped: string[] }> {
    return this.post("/v1/plugins/new", args);
  }

  // ── private helpers ──

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = this.timeoutMs > 0 ? new AbortController() : undefined;
    const timer =
      controller && this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;
    try {
      const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", Accept: "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      };
      const res = await this.fetchImpl(url, init);
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        throw new TierkitClientError(
          "bad-response",
          `non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`,
          res.status,
        );
      }
      // The daemon returns 400 with a JSON body for predictable failures (unknown-profile,
      // dangerous-command-blocked, etc.). Return those as-typed for the caller to inspect,
      // rather than throwing — they're part of the contract.
      if (!res.ok && res.status !== 400) {
        const err = parsed as { error?: string; code?: string; message?: string } | undefined;
        throw new TierkitClientError(
          err?.code ?? "bad-status",
          err?.error ?? err?.message ?? `${method} ${url} → ${res.status}`,
          res.status,
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof TierkitClientError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new TierkitClientError("timeout", `request to ${url} exceeded ${this.timeoutMs}ms`);
      }
      throw new TierkitClientError("network-error", `${method} ${url}: ${(err as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
