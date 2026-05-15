import path from "node:path";
import { redactSecrets } from "../../security/SecretRedactor.js";
import { classifyCommand } from "../../security/dangerousCommands.js";
import { loadConfig } from "../../config/loadConfig.js";
import { pickProviderClient } from "../../model/providers/index.js";
import type { ChatMessage } from "../../model/providers/chatTypes.js";
import { appendUsage, estimateCost, type UsageRecord } from "../usageLog.js";
import { checkBudget } from "../budget.js";

export interface LlmCallRequest {
  /** Model profile id to route the call through. */
  profileId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Shell commands the agent intends to run as part of this turn. If any classifies as `block`,
   * the call is rejected. `warn`-level commands proceed but their classifications are returned
   * so the agent can surface approval prompts.
   */
  toolCommands?: string[];
}

export interface LlmCallOk {
  ok: true;
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  profileId: string;
  model: string;
  redactionHits: { ruleId: string; count: number }[];
  commandClassifications: { command: string; severity: "ok" | "warn" | "block" }[];
  budget: { status: "ok" | "warn" | "block"; reason?: string };
}

export interface LlmCallFail {
  ok: false;
  code: string;
  message: string;
  /** Optional latency for transport-style errors. */
  latencyMs?: number;
}

export type LlmCallResult = LlmCallOk | LlmCallFail;

export interface LlmCallContext {
  cwd: string;
  env: Record<string, string | undefined>;
}

/**
 * End-to-end proxied LLM call:
 *   1. Load config; find profile by id.
 *   2. Classify any tool commands. If any is `block`, refuse the call.
 *   3. Check the budget. If status is `block`, refuse.
 *   4. Redact secrets from outbound messages when the profile is on a remote tier
 *      AND `security.redactSecretsForRemote` is true (default).
 *   5. Dispatch to the provider client's `chat()`.
 *   6. Append a usage record (success OR failure) to the runtime usage log.
 *   7. Return result with all the policy decisions exposed.
 */
export async function executeLlmCall(
  request: LlmCallRequest,
  context: LlmCallContext,
): Promise<LlmCallResult> {
  const cfg = await loadConfig(context.cwd);
  if (!cfg.found) {
    return {
      ok: false,
      code: "no-config",
      message: "no tierkit.config.json found; run `tierkit init` first",
    };
  }
  const profile = cfg.config.modelProfiles[request.profileId];
  if (!profile) {
    const known = Object.keys(cfg.config.modelProfiles);
    return {
      ok: false,
      code: "unknown-profile",
      message: `unknown profile "${request.profileId}". Known: ${known.join(", ") || "(none)"}`,
    };
  }

  const commandClassifications = (request.toolCommands ?? []).map((cmd) => {
    const c = classifyCommand(cmd);
    return { command: cmd, severity: c.severity, matched: c.matched };
  });
  const blockedCommand = commandClassifications.find((c) => c.severity === "block");
  if (blockedCommand) {
    return {
      ok: false,
      code: "dangerous-command-blocked",
      message: `tool command "${blockedCommand.command}" classified as block (${blockedCommand.matched.map((m) => m.id).join(", ")})`,
    };
  }

  const usageLogPath = path.join(
    context.cwd,
    cfg.config.runtime.dataDir,
    "usage.jsonl",
  );
  const budgetCheck = await checkBudget(usageLogPath, cfg.config.budget);
  if (budgetCheck.status === "block") {
    return {
      ok: false,
      code: "budget-exceeded",
      message: budgetCheck.reason ?? "budget exceeded",
    };
  }

  // Redact outbound messages for remote tiers when the policy says so.
  const isRemote = profile.kind !== "local-device";
  const shouldRedact = isRemote && cfg.config.security.redactSecretsForRemote !== false;
  let redactedMessages = request.messages;
  const allHits: { ruleId: string; count: number }[] = [];
  if (shouldRedact) {
    redactedMessages = request.messages.map((m) => {
      const r = redactSecrets(m.content);
      for (const h of r.hits) {
        const existing = allHits.find((x) => x.ruleId === h.ruleId);
        if (existing) existing.count += h.count;
        else allHits.push({ ...h });
      }
      return { ...m, content: r.text };
    });
  }

  const client = pickProviderClient(profile);
  if (!client) {
    return {
      ok: false,
      code: "not-implemented",
      message: `provider "${profile.provider}" has no chat client in this Tierkit version`,
    };
  }

  const chatResult = await client.chat(
    profile,
    {
      messages: redactedMessages,
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    },
    context.env,
  );

  // Always log — success or failure — so usage history is complete.
  const record: UsageRecord = {
    timestamp: new Date().toISOString(),
    profileId: request.profileId,
    provider: profile.provider,
    model: profile.model,
    tier: profile.kind,
    inputTokens: chatResult.ok ? chatResult.usage.inputTokens : 0,
    outputTokens: chatResult.ok ? chatResult.usage.outputTokens : 0,
    costUsd: chatResult.ok
      ? estimateCost(profile, chatResult.usage.inputTokens, chatResult.usage.outputTokens)
      : 0,
    latencyMs: chatResult.latencyMs,
    ok: chatResult.ok,
    ...(chatResult.ok ? {} : { failureCode: chatResult.code }),
  };
  await appendUsage(usageLogPath, record);

  if (!chatResult.ok) {
    return {
      ok: false,
      code: chatResult.code,
      message: chatResult.message,
      latencyMs: chatResult.latencyMs,
    };
  }

  return {
    ok: true,
    text: chatResult.text,
    inputTokens: chatResult.usage.inputTokens,
    outputTokens: chatResult.usage.outputTokens,
    costUsd: record.costUsd,
    latencyMs: chatResult.latencyMs,
    profileId: request.profileId,
    model: chatResult.model,
    redactionHits: allHits,
    commandClassifications: commandClassifications.map((c) => ({
      command: c.command,
      severity: c.severity,
    })),
    budget: { status: budgetCheck.status, ...(budgetCheck.reason ? { reason: budgetCheck.reason } : {}) },
  };
}
