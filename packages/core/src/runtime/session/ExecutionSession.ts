import { z } from "zod";
import { FREEDOM_LEVELS } from "../../plugin/PluginManifest.js";

export const SESSION_STATES = [
  "planning",
  "implementing",
  "reviewing",
  "done",
  "abandoned",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const SessionEventSchema = z
  .object({
    timestamp: z.string(),
    from: z.enum(SESSION_STATES).nullable(),
    to: z.enum(SESSION_STATES),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const ExecutionSessionSchema = z
  .object({
    id: z.string().min(1),
    task: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    state: z.enum(SESSION_STATES),
    /** Strict mode requires the plan to be explicitly approved before mode=execute is allowed. */
    planApproved: z.boolean().default(false),
    /** Strict mode requires a review pass before state=done. */
    reviewApproved: z.boolean().default(false),
    /** Captured freedom level at session start (so a later plugin change can't quietly downgrade enforcement). */
    freedom: z.enum(FREEDOM_LEVELS),
    history: z.array(SessionEventSchema).default([]),
  })
  .strict();

export type ExecutionSession = z.infer<typeof ExecutionSessionSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
