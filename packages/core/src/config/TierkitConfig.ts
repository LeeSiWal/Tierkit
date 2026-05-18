import { z } from "zod";
import { ModelPolicySchema, ModelProfileMapSchema } from "../model/ModelProfile.js";
import { TARGETS } from "../plugin/PluginManifest.js";

export const RiskThresholdsSchema = z
  .object({
    localFastMax: z.number().int().min(0).max(100).default(25),
    localStrongMax: z.number().int().min(0).max(100).default(50),
    privateRemoteMax: z.number().int().min(0).max(100).default(75),
    publicCloudReviewMin: z.number().int().min(0).max(100).default(76),
  })
  .strict();

export const RoutingPolicySchema = z
  .object({
    default: z.string().min(1).optional(),
    preferPrivateRemoteBeforePublicCloud: z.boolean().default(true),
    publicCloudRequiresApproval: z.boolean().default(true),
    publicCloudDefaultMode: z.enum(["execute", "review-only"]).default("review-only"),
    autoEscalationCeiling: z.enum(["local-device", "private-remote", "public-cloud"]).default("public-cloud"),
    budgetAwareDowngrade: z.boolean().default(true),
    responseQualityCheck: z.boolean().default(true),
    riskThresholds: RiskThresholdsSchema.default({
      localFastMax: 25,
      localStrongMax: 50,
      privateRemoteMax: 75,
      publicCloudReviewMin: 76,
    }),
  })
  .strict();

export const SecurityPolicySchema = z
  .object({
    redactSecretsForRemote: z.boolean().default(true),
    blockSecretFiles: z.boolean().default(true),
    dangerousCommandsRequireApproval: z.boolean().default(true),
  })
  .strict();

export const BudgetPolicySchema = z
  .object({
    dailyUsdLimit: z.number().nonnegative().optional(),
    monthlyUsdLimit: z.number().nonnegative().optional(),
    warnAtPercent: z.number().min(0).max(100).default(70),
    blockAtPercent: z.number().min(0).max(100).default(100),
  })
  .strict();

export const RuntimeConfigSchema = z
  .object({
    /** TCP port the local runtime daemon binds to. 0 = pick any free port. */
    port: z.number().int().min(0).max(65535).default(4101),
    /** Directory (relative to project root) where the daemon stores PID file, port file, and usage log. */
    dataDir: z.string().min(1).default(".tierkit/runtime"),
    /** Bind address. Defaults to localhost-only; never change without explicit user consent — see SECURITY.md. */
    host: z.string().min(1).default("127.0.0.1"),
    /**
     * When true (default), the daemon prepends the rules of every active Tierkit plugin
     * as a system message before forwarding to the provider. This is how plugin rules
     * (e.g. `superpowers-strict`'s plan-approval-gate, tests-first) actually influence
     * model behavior — without injection, plugin rules only show up in EXPORTED tool
     * configs (.roomodes, .clinerules/, .continue/), but never in Tierkit's own
     * `/v1/openai/chat/completions` path.
     *
     * Set false if you handle rule injection at the client side (some workflows want to
     * see plain user messages on the wire for debugging).
     */
    injectPluginRules: z.boolean().default(true),
    /**
     * Tool-shim mode: how Tierkit handles OpenAI structured tool calling for models that
     * don't reliably emit `tool_calls` (most local Ollama models).
     *
     *   - `"auto"` (default): apply the shim only for local-device profiles, where small
     *     models commonly emit tool calls as text/JSON-in-content rather than structured.
     *     Anthropic/OpenAI providers use their native structured tool calling.
     *   - `"on"`: force the shim for every profile.
     *   - `"off"`: pass `tools` through to every provider untouched. Use this when you
     *     know all your profiles have rock-solid OpenAI tool-call support.
     *
     * What the shim does, end-to-end:
     *   1. Convert OpenAI `tools` array → XML-tag instructions in the system prompt
     *   2. Strip `tools` from the outgoing provider request
     *   3. Parse the model's text response for `<tool_name>...</tool_name>` or
     *      `{"name": "...", "arguments": {...}}` patterns
     *   4. Return as OpenAI-shape `tool_calls` to the caller (Roo/Cline/etc don't know
     *      the shim happened)
     */
    toolShim: z.enum(["auto", "on", "off"]).default("auto"),
    /**
     * When true (default), Tierkit probes a running Ollama daemon's `/api/tags` on each
     * `loadConfig()` (cached for 30 seconds) and synthesizes a model profile per installed
     * chat-capable model. So any user who has Ollama with models pulled — regardless of
     * which models — gets viable local profiles in `/models` and auto-route candidates
     * without writing a single line of config.
     *
     * Generated profile ids look like `ollama-qwen2-5-coder-7b` (the model name sanitized).
     * Source is reported as `"discovered"` in listModels output.
     *
     * Set false to suppress discovery — useful if you have a small set of carefully-
     * defined profiles and don't want the auto-route to consider random installed models.
     */
    discoverOllamaModels: z.boolean().default(true),
  })
  .strict();

export const TierkitConfigSchema = z
  .object({
    version: z.literal("0.1"),
    activePlugins: z.array(z.string().min(1)).default([]),
    defaultTarget: z.enum(TARGETS).default("generic"),
    modelProfiles: ModelProfileMapSchema.default({}),
    disabledProfileIds: z.array(z.string().min(1)).default([]),
    routingPolicy: RoutingPolicySchema.default({
      preferPrivateRemoteBeforePublicCloud: true,
      publicCloudRequiresApproval: true,
      publicCloudDefaultMode: "review-only",
      riskThresholds: {
        localFastMax: 25,
        localStrongMax: 50,
        privateRemoteMax: 75,
        publicCloudReviewMin: 76,
      },
    }),
    security: SecurityPolicySchema.default({
      redactSecretsForRemote: true,
      blockSecretFiles: true,
      dangerousCommandsRequireApproval: true,
    }),
    budget: BudgetPolicySchema.optional(),
    modelPolicy: ModelPolicySchema.optional(),
    runtime: RuntimeConfigSchema.default({
      port: 4101,
      dataDir: ".tierkit/runtime",
      host: "127.0.0.1",
    }),
  })
  .strict();

export type TierkitConfig = z.infer<typeof TierkitConfigSchema>;

export const CONFIG_FILENAME = "tierkit.config.json";
