import { z } from "zod";
import { CommandDefinitionSchema } from "../command/CommandDefinition.js";
import { ModelPolicySchema } from "../model/ModelProfile.js";
import { PermissionFlagsSchema } from "../security/Permission.js";

export const TARGETS = ["roo", "zoo", "cline", "continue", "claude-code", "generic"] as const;
export type Target = (typeof TARGETS)[number];

export const FREEDOM_LEVELS = ["free", "guided", "balanced", "strict"] as const;
export type FreedomLevel = (typeof FREEDOM_LEVELS)[number];

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$/;
const SEMVER_RANGE = /^[\^~><=*\d. \-A-Za-z+]+$/;

export const ModeDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, "mode id must be kebab-case starting with a letter"),
    name: z.string().min(1),
    file: z.string().min(1),
    tools: z.array(z.string().min(1)).default([]),
    role: z.string().min(1),
  })
  .strict();

export type ModeDefinition = z.infer<typeof ModeDefinitionSchema>;

export const PluginComponentsSchema = z
  .object({
    commands: z.array(CommandDefinitionSchema).default([]),
    modes: z.array(ModeDefinitionSchema).default([]),
    rules: z.array(z.string().min(1)).default([]),
    workflows: z.array(z.string().min(1)).default([]),
    hooks: z.array(z.string().min(1)).default([]),
    mcpServers: z.string().min(1).optional(),
  })
  .strict();

export type PluginComponents = z.infer<typeof PluginComponentsSchema>;

export const PluginManifestSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, "plugin id must be kebab-case starting with a letter"),
    name: z.string().min(1),
    version: z.string().regex(SEMVER, "version must be semver"),
    description: z.string().min(1),
    author: z.string().min(1),
    license: z.string().min(1).default("MIT"),
    compatibility: z
      .object({
        tierkit: z.string().regex(SEMVER_RANGE, "tierkit compatibility must be a semver range"),
        targets: z.array(z.enum(TARGETS)).min(1),
      })
      .strict(),
    components: PluginComponentsSchema.default({
      commands: [],
      modes: [],
      rules: [],
      workflows: [],
      hooks: [],
    }),
    permissions: PermissionFlagsSchema,
    modelPolicy: ModelPolicySchema.optional(),
    freedom: z
      .object({
        level: z.enum(FREEDOM_LEVELS),
      })
      .strict(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
