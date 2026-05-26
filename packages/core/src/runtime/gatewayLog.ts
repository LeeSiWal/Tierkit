import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const GATEWAY_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const GATEWAY_LOG_MAX_AGE_DAYS = 7;
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;

const GatewayTransformationMetricSchema = z
  .object({
    mode: z.enum(["off", "observe", "envelope"]),
    outcome: z.enum([
      "disabled",
      "observed",
      "transformed",
      "bypassed_ineligible",
      "bypassed_error",
    ]),
    ruleId: z.literal("tool_result_envelope_v1").nullable(),
    eligibleToolResultCount: z.number().int().nonnegative(),
    transformedToolResultCount: z.number().int().nonnegative(),
    inputUtf8BytesBefore: z.number().int().nonnegative().nullable(),
    inputUtf8BytesAfter: z.number().int().nonnegative().nullable(),
    reducedUtf8Bytes: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.transformedToolResultCount > v.eligibleToolResultCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transformedToolResultCount"],
        message: "transformedToolResultCount cannot exceed eligibleToolResultCount",
      });
    }
    if (v.mode === "off" && v.transformedToolResultCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transformedToolResultCount"],
        message: "off mode cannot transform results",
      });
    }
    if (v.outcome === "transformed" && v.transformedToolResultCount < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transformedToolResultCount"],
        message: "transformed outcome requires transformedToolResultCount >= 1",
      });
    }
    if (v.inputUtf8BytesBefore !== null || v.inputUtf8BytesAfter !== null || v.reducedUtf8Bytes !== null) {
      if (v.inputUtf8BytesBefore === null || v.inputUtf8BytesAfter === null || v.reducedUtf8Bytes === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reducedUtf8Bytes"],
          message: "byte fields must be all null or all non-null",
        });
      } else if (v.inputUtf8BytesBefore - v.inputUtf8BytesAfter !== v.reducedUtf8Bytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reducedUtf8Bytes"],
          message: "reducedUtf8Bytes must equal inputUtf8BytesBefore - inputUtf8BytesAfter",
        });
      }
    }
  });

const GatewayAuthSchema = z
  .object({
    authorizationScheme: z.enum(["Bearer", "Other"]).nullable(),
    authorizationFingerprint: z.string().regex(FINGERPRINT_RE).nullable(),
    apiKeyPresent: z.boolean(),
    apiKeyFingerprint: z.string().regex(FINGERPRINT_RE).nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.authorizationScheme === null) !== (v.authorizationFingerprint === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizationFingerprint"],
        message: "authorizationFingerprint and authorizationScheme must both be null or both be non-null",
      });
    }
    if (v.apiKeyPresent === false && v.apiKeyFingerprint !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyFingerprint"],
        message: "apiKeyFingerprint must be null when apiKeyPresent is false",
      });
    }
    if (v.apiKeyPresent === true && v.apiKeyFingerprint === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyFingerprint"],
        message: "apiKeyFingerprint is required when apiKeyPresent is true",
      });
    }
  });

const GatewayLogRecordSchema = z
  .object({
    ts: z.string().datetime(),
    path: z.enum(["/v1/messages", "/v1/messages/count_tokens"]),
    stream: z.boolean(),
    status: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    auth: GatewayAuthSchema,
    transformation: GatewayTransformationMetricSchema.optional(),
  })
  .strict();

export type GatewayLogRecord = z.infer<typeof GatewayLogRecordSchema>;

export interface AppendGatewayLogOptions { now?: Date; }

function projectAndValidate(input: unknown): GatewayLogRecord {
  if (!input || typeof input !== "object") throw new Error("gateway log input must be an object");
  const r = input as Record<string, unknown>;
  const a = (r.auth && typeof r.auth === "object" ? r.auth : {}) as Record<string, unknown>;
  const t = (r.transformation && typeof r.transformation === "object" ? r.transformation : undefined) as
    | Record<string, unknown>
    | undefined;
  return GatewayLogRecordSchema.parse({
    ts: r.ts,
    path: r.path,
    stream: r.stream,
    status: r.status,
    durationMs: r.durationMs,
    auth: {
      authorizationScheme: a.authorizationScheme,
      authorizationFingerprint: a.authorizationFingerprint,
      apiKeyPresent: a.apiKeyPresent,
      apiKeyFingerprint: a.apiKeyFingerprint,
    },
    ...(t
      ? {
          transformation: {
            mode: t.mode,
            outcome: t.outcome,
            ruleId: t.ruleId,
            eligibleToolResultCount: t.eligibleToolResultCount,
            transformedToolResultCount: t.transformedToolResultCount,
            inputUtf8BytesBefore: t.inputUtf8BytesBefore,
            inputUtf8BytesAfter: t.inputUtf8BytesAfter,
            reducedUtf8Bytes: t.reducedUtf8Bytes,
          },
        }
      : {}),
  });
}

let writeQueue: Promise<unknown> = Promise.resolve();

export async function appendGatewayLog(
  filePath: string,
  input: unknown,
  opts: AppendGatewayLogOptions = {},
): Promise<void> {
  const record = projectAndValidate(input);
  const line = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(line, "utf8") > GATEWAY_LOG_MAX_BYTES) {
    throw new Error("gateway log record exceeds maximum file size");
  }
  const work = writeQueue.then(() => appendImpl(filePath, line, opts));
  writeQueue = work.catch(() => undefined);
  await work;
}

async function appendImpl(filePath: string, line: string, opts: AppendGatewayLogOptions): Promise<void> {
  const now = opts.now ?? new Date();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, "utf8");
  await maybeTrim(filePath, now);
}

function ageCutoffMs(now: Date): number {
  return now.getTime() - GATEWAY_LOG_MAX_AGE_DAYS * 86_400_000;
}

async function maybeTrim(filePath: string, now: Date): Promise<void> {
  let needsTrim = false;
  try {
    const s = await fs.stat(filePath);
    if (s.size > GATEWAY_LOG_MAX_BYTES) needsTrim = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!needsTrim) {
    const fd = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      if (bytesRead > 0) {
        const nl = buf.indexOf(0x0a);
        if (nl > 0) {
          try {
            const parsed = JSON.parse(buf.subarray(0, nl).toString("utf8")) as { ts?: string };
            if (parsed.ts && new Date(parsed.ts).getTime() < ageCutoffMs(now)) needsTrim = true;
          } catch { needsTrim = true; }
        }
      }
    } finally { await fd.close(); }
  }
  if (!needsTrim) return;

  const raw = await fs.readFile(filePath, "utf8");
  const cutoff = ageCutoffMs(now);
  const ageKept: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: string };
      if (parsed.ts && new Date(parsed.ts).getTime() >= cutoff) ageKept.push(line);
    } catch { /* drop malformed */ }
  }
  const kept: string[] = [];
  let keptBytes = 0;
  for (let i = ageKept.length - 1; i >= 0; i--) {
    const sz = Buffer.byteLength(ageKept[i]!, "utf8") + 1;
    if (keptBytes + sz > GATEWAY_LOG_MAX_BYTES) break;
    kept.unshift(ageKept[i]!);
    keptBytes += sz;
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "");
  await fs.rename(tmp, filePath);
}

export function gatewayLogPath(dataDir: string): string {
  return path.join(dataDir, "anthropic-gateway.jsonl");
}
