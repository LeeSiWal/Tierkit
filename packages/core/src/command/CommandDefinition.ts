import { z } from "zod";

export const COMMAND_CATEGORIES = [
  "planning",
  "review",
  "debugging",
  "execution",
  "routing",
  "misc",
] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export const CommandDefinitionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, "command name must be kebab-case starting with a letter"),
    file: z.string().min(1),
    description: z.string().min(1),
    category: z.enum(COMMAND_CATEGORIES).default("misc"),
  })
  .strict();

export type CommandDefinition = z.infer<typeof CommandDefinitionSchema>;
