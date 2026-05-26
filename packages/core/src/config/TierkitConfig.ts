import { z } from "zod";
import { ContextCompressionConfigSchema } from "../context-compression/schema.js";
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

/**
 * Per-profile budget caps. Whichever cap (USD or input tokens, daily or monthly)
 * is reached first blocks calls to this profile until reset or until the cap is
 * raised. Token caps count INPUT TOKENS only — output cost is reflected in the
 * USD-based caps via accumulated usage.
 *
 * Boundary: `>` comparison — at-limit allowed, over-limit blocked.
 *
 * Per-paymentModel semantics:
 *   per-token: USD + input-token caps both enforced.
 *   flat-rate: USD caps are display-only metadata (subscription already paid).
 *              Input-token cap protects subscription quota.
 *   free:      USD caps are ignored. Input-token cap protects local resources.
 *
 * `tierkit doctor` warns when USD limits are set on flat-rate or free profiles.
 */
export const PerProfileBudgetSchema = z
  .object({
    dailyUsdLimit:           z.number().nonnegative().optional(),
    monthlyUsdLimit:         z.number().nonnegative().optional(),
    dailyInputTokenLimit:    z.number().int().nonnegative().optional(),
    monthlyInputTokenLimit:  z.number().int().nonnegative().optional(),
  })
  .strict();

export type PerProfileBudget = z.infer<typeof PerProfileBudgetSchema>;

export const BudgetPolicySchema = z
  .object({
    dailyUsdLimit: z.number().nonnegative().optional(),
    monthlyUsdLimit: z.number().nonnegative().optional(),
    /** Per-profile budgets (optional). Whichever cap is reached first applies. */
    perProfile: z.record(z.string(), PerProfileBudgetSchema).optional(),
    warnAtPercent: z.number().min(0).max(100).default(70),
    blockAtPercent: z.number().min(0).max(100).default(100),
  })
  .strict();

export const GatewayTransformationModeSchema = z.enum(["off", "observe", "envelope"]);

export const GatewayToolResultEnvelopeConfigSchema = z
  .object({
    allowlistedToolNames: z.array(z.string().min(1)).default([]),
    minInputUtf8Bytes: z.number().int().min(0).max(10 * 1024 * 1024).default(4096),
    preservedHeadUtf8Bytes: z.number().int().min(0).max(64 * 1024).default(1024),
    preservedTailUtf8Bytes: z.number().int().min(0).max(64 * 1024).default(1024),
  })
  .strict();

export const GatewayTransformationsConfigSchema = z
  .object({
    mode: GatewayTransformationModeSchema.default("off"),
    toolResultEnvelope: GatewayToolResultEnvelopeConfigSchema.default({
      allowlistedToolNames: [],
      minInputUtf8Bytes: 4096,
      preservedHeadUtf8Bytes: 1024,
      preservedTailUtf8Bytes: 1024,
    }),
  })
  .strict()
  .default({
    mode: "off",
    toolResultEnvelope: {
      allowlistedToolNames: [],
      minInputUtf8Bytes: 4096,
      preservedHeadUtf8Bytes: 1024,
      preservedTailUtf8Bytes: 1024,
    },
  });

export type GatewayTransformationMode = z.infer<typeof GatewayTransformationModeSchema>;
export type GatewayTransformationsConfig = z.infer<typeof GatewayTransformationsConfigSchema>;

export const MeasuredCompactModeSchema = z.enum(["off", "measured_compact"]);
export const OfficialTokenMeasurementModeSchema = z.enum(["off", "anthropic_count_tokens_opt_in"]);

export const MeasuredCompactConfigSchema = z
  .object({
    mode: MeasuredCompactModeSchema.default("off"),
    eligibleSources: z
      .object({
        tierkitMcpCompactTools: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ tierkitMcpCompactTools: [] }),
    officialTokenMeasurement: z
      .object({
        mode: OfficialTokenMeasurementModeSchema.default("off"),
        consentAcknowledged: z.boolean().default(false),
      })
      .strict()
      .default({ mode: "off", consentAcknowledged: false }),
    privacy: z
      .object({
        rawBaselineStorage: z.literal("memory_only").default("memory_only"),
        rawBaselineTtlMs: z.number().int().min(1_000).max(10 * 60_000).default(60_000),
        maxRawBaselineBytes: z.number().int().min(1).max(10 * 1024 * 1024).default(1_048_576),
      })
      .strict()
      .default({
        rawBaselineStorage: "memory_only",
        rawBaselineTtlMs: 60_000,
        maxRawBaselineBytes: 1_048_576,
      }),
    reporting: z
      .object({
        requestLevelMetrics: z.boolean().default(true),
        sessionAggregation: z.boolean().default(false),
      })
      .strict()
      .default({ requestLevelMetrics: true, sessionAggregation: false }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.officialTokenMeasurement.mode === "anthropic_count_tokens_opt_in" && !v.officialTokenMeasurement.consentAcknowledged) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["officialTokenMeasurement", "consentAcknowledged"],
        message: "official token measurement requires explicit consent acknowledgement",
      });
    }
    if (v.mode === "off" && v.officialTokenMeasurement.mode !== "off") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["officialTokenMeasurement", "mode"],
        message: "official token measurement requires measuredCompact.mode to be measured_compact",
      });
    }
  })
  .default({
    mode: "off",
    eligibleSources: { tierkitMcpCompactTools: [] },
    officialTokenMeasurement: { mode: "off", consentAcknowledged: false },
    privacy: {
      rawBaselineStorage: "memory_only",
      rawBaselineTtlMs: 60_000,
      maxRawBaselineBytes: 1_048_576,
    },
    reporting: { requestLevelMetrics: true, sessionAggregation: false },
  });

export type MeasuredCompactMode = z.infer<typeof MeasuredCompactModeSchema>;
export type MeasuredCompactConfig = z.infer<typeof MeasuredCompactConfigSchema>;

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
    /**
     * Anthropic Gateway flag. When "on", the daemon serves /v1/messages and
     * /v1/messages/count_tokens as a transparent passthrough so Claude Code
     * can be pointed at it via ANTHROPIC_BASE_URL. Default "off".
     *
     * This flag does NOT enable any request/response transformation.
     */
    gatewayMode: z.enum(["off", "on"]).default("off"),
    gatewayTransformations: GatewayTransformationsConfigSchema,
    measuredCompact: MeasuredCompactConfigSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.measuredCompact.mode === "measured_compact" && v.gatewayTransformations.mode === "envelope") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["measuredCompact", "mode"],
        message: "measured compact cannot run with legacy gateway envelope transformations",
      });
    }
  });

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
    contextCompression: ContextCompressionConfigSchema.optional(),
    runtime: RuntimeConfigSchema.default({
      port: 4101,
      dataDir: ".tierkit/runtime",
      host: "127.0.0.1",
    }),
    /**
     * v0.17: profile id used as the cost baseline for the Savings card. The
     * "estimated cost saved" metric assumes that every local-device call would
     * have gone to this profile instead, and multiplies the routed tokens by
     * its per-token cost. Optional — when absent, defaults to `"claudeCode"`.
     * Resolution: if the id is missing from `modelProfiles` OR the profile
     * lacks `cost`, the Savings endpoint returns `baselineConfigured:false`.
     */
    routingBaseline: z.string().min(1).optional(),
    migrations: z.object({
      defaultDisabledSeededProfileIds: z.array(z.string().min(1)).default([]),
    }).default({}),
    notices: z.object({
      seenPinnedNoFallbackV013: z.boolean().default(false),
      seenModelTestExplained: z.boolean().default(false),
      seenOnboarding: z.boolean().default(false),
    }).default({}),
  })
  .strict();

export type TierkitConfig = z.infer<typeof TierkitConfigSchema>;

export const CONFIG_FILENAME = "tierkit.config.json";
