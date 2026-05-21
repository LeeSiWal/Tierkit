/**
 * Bundled default model profiles.
 *
 * These ship with the Tierkit core so new users see useful profiles in `/models` even
 * without writing a `tierkit.config.json`. They are templates — the actual call only
 * works when the prerequisite is satisfied (env var set, Ollama running, etc.). The
 * `/v1/models/test` endpoint reports each profile's readiness so users can see what's
 * usable on their machine.
 *
 * Precedence (low → high): bundled defaults → ~/.tierkit/config.json → ./tierkit.config.json.
 * Workspace and user configs can override a bundled profile (same id) or remove it (set
 * to `null` in the user config — see `loadConfig.ts` merge logic).
 */
import type { ModelProfileMap } from "../model/ModelProfile.js";

export const DEFAULT_MODEL_PROFILES: ModelProfileMap = {
  // ── local-device (Ollama, no API key) ─────────────────────────────────────────
  localCoder: {
    kind: "local-device",
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    baseUrl: "http://127.0.0.1:11434",
    roles: ["code", "review", "plan"],
    notGoodAt: ["code-review", "plan", "refactor"],
    cost: { type: "free" },
  },
  localFast: {
    kind: "local-device",
    provider: "ollama",
    model: "llama3.2:3b",
    baseUrl: "http://127.0.0.1:11434",
    roles: ["small", "summarize"],
    notGoodAt: ["code-review", "plan", "refactor"],
    cost: { type: "free" },
  },

  // ── private-remote (Anthropic — ANTHROPIC_API_KEY) ────────────────────────────
  claudeSonnet: {
    kind: "private-remote",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    roles: ["code", "review", "plan"],
    cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  },
  claudeHaiku: {
    kind: "private-remote",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    roles: ["small", "summarize"],
    cost: { type: "per-token", inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
  },

  // ── public-cloud (OpenAI — OPENAI_API_KEY; requiresApproval enforced by schema) ──
  gpt4o: {
    kind: "public-cloud",
    provider: "openai",
    model: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
    roles: ["review", "plan"],
    requiresApproval: true,
    defaultMode: "review-only",
    cost: { type: "per-token", inputUsdPerMillion: 5, outputUsdPerMillion: 15 },
  },
  gpt4oMini: {
    kind: "public-cloud",
    provider: "openai",
    model: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    roles: ["small", "summarize"],
    requiresApproval: true,
    defaultMode: "review-only",
    cost: { type: "per-token", inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  },

  // ── public-cloud subscription CLI (v0.13) ────────────────────────────────────
  // Disabled by default — `migrateSeedDefaultDisabled` adds this id to
  // `disabledProfileIds` on first workspace load. Once seeded, user-driven enable
  // is respected and never re-undone.
  // No `cost` declared: the subscription is paid out of band, so per-call costUsd = 0.
  // kind: "public-cloud" because data flows to Anthropic's cloud — same trust
  // boundary as gpt4o. defaultMode: "review-only" matches that trust classification.
  claudeCode: {
    kind: "public-cloud",
    paymentModel: "flat-rate",
    provider: "claude-code",
    model: "auto",
    displayName: "Claude Code",
    roles: ["code", "review", "plan"],
    goodAt: ["code-review", "planning", "debugging", "large-refactor"],
    requiresApproval: true,
    defaultMode: "review-only",
    defaultDisabled: true,
    transport: {
      type: "subprocess",
      command: "claude",
      args: ["-p", "--output-format", "json"],
      healthCheckArgs: ["--version"],
      timeoutMs: 120_000,
      maxStdoutBytes: 2_000_000,
      maxStderrBytes: 524_288,
    },
  },
};

export const DEFAULT_PROFILE_IDS = Object.keys(DEFAULT_MODEL_PROFILES);
