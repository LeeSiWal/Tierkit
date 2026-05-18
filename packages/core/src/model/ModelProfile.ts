import { z } from "zod";

export const MODEL_TIERS = ["local-device", "private-remote", "public-cloud"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const FreeCostSchema = z.object({ type: z.literal("free") }).strict();
const PerTokenCostSchema = z
  .object({
    type: z.literal("per-token"),
    inputUsdPerMillion: z.number().nonnegative(),
    outputUsdPerMillion: z.number().nonnegative(),
  })
  .strict();
const FlatCostSchema = z
  .object({
    type: z.literal("flat"),
    monthlyUsd: z.number().nonnegative(),
  })
  .strict();

export const ModelCostSchema = z.discriminatedUnion("type", [
  FreeCostSchema,
  PerTokenCostSchema,
  FlatCostSchema,
]);
export type ModelCost = z.infer<typeof ModelCostSchema>;

export const ModelProfileSchema = z
  .object({
    kind: z.enum(MODEL_TIERS),
    provider: z.string().min(1),
    baseUrl: z.string().url().optional(),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).optional(),
    roles: z.array(z.string().min(1)).default([]),
    requiresApproval: z.boolean().optional(),
    defaultMode: z.enum(["execute", "review-only"]).optional(),
    goodAt: z.array(z.string().min(1)).optional(),
    /**
     * Task types this profile should NOT be considered for. Hard filter (not just sort
     * deprioritization) — applied in ModelRouter.sortProfilesForTier. Used to keep weak
     * models (e.g., llama3.2:3b) out of code-* chains even when they're the only local
     * option available. When the filter empties a tier, escalation moves to the next tier
     * (typically private-remote → cloud), which is what we want: better to escalate than
     * to send code-review work to a 3B model.
     */
    notGoodAt: z.array(z.string().min(1)).optional(),
    enabled: z.boolean().optional(),
    cost: ModelCostSchema.optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.kind === "public-cloud" && profile.requiresApproval === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresApproval"],
        message:
          "public-cloud model profiles must require approval; Tierkit defaults to review-only for public-cloud.",
      });
    }
  });

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelProfileMapSchema = z.record(z.string().min(1), ModelProfileSchema);
export type ModelProfileMap = z.infer<typeof ModelProfileMapSchema>;

export const ModelPolicySchema = z
  .object({
    defaultTier: z.string().min(1).optional(),
    preferPrivateRemoteBeforePublicCloud: z.boolean().default(true),
    publicCloudRequiresApproval: z.boolean().default(true),
    publicCloudDefaultMode: z.enum(["execute", "review-only"]).default("review-only"),
  })
  .strict();

export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
