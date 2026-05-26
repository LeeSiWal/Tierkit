import crypto from "node:crypto";
import type { GatewayTransformationsConfig } from "../config/TierkitConfig.js";

export type TransformationOutcome =
  | "disabled"
  | "observed"
  | "transformed"
  | "bypassed_ineligible"
  | "bypassed_error";

export interface GatewayTransformationMetric {
  mode: "off" | "observe" | "envelope";
  outcome: TransformationOutcome;
  ruleId: "tool_result_envelope_v1" | null;
  eligibleToolResultCount: number;
  transformedToolResultCount: number;
  inputUtf8BytesBefore: number | null;
  inputUtf8BytesAfter: number | null;
  reducedUtf8Bytes: number | null;
}

export interface TransformRequestResult {
  body: Buffer;
  metric: GatewayTransformationMetric;
  changed: boolean;
}

const RULE_ID = "tool_result_envelope_v1" as const;
const ENVELOPE_MARKER = "[TIERKIT_TOOL_RESULT_ENVELOPE_V1]";

export function disabledGatewayTransformationMetric(): GatewayTransformationMetric {
  return {
    mode: "off",
    outcome: "disabled",
    ruleId: null,
    eligibleToolResultCount: 0,
    transformedToolResultCount: 0,
    inputUtf8BytesBefore: null,
    inputUtf8BytesAfter: null,
    reducedUtf8Bytes: null,
  };
}

export function bypassedErrorGatewayTransformationMetric(
  mode: "off" | "observe" | "envelope",
): GatewayTransformationMetric {
  return {
    mode,
    outcome: "bypassed_error",
    ruleId: mode === "off" ? null : RULE_ID,
    eligibleToolResultCount: 0,
    transformedToolResultCount: 0,
    inputUtf8BytesBefore: null,
    inputUtf8BytesAfter: null,
    reducedUtf8Bytes: null,
  };
}

export function transformAnthropicGatewayRequest(
  rawBody: Buffer,
  config: GatewayTransformationsConfig,
): TransformRequestResult {
  if (config.mode === "off") {
    return { body: rawBody, metric: disabledGatewayTransformationMetric(), changed: false };
  }

  const beforeBytes = rawBody.byteLength;
  const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  const toolNamesById = collectToolUseNames(parsed);
  const candidates = findToolResultCandidates(parsed, toolNamesById);

  if (config.mode === "observe") {
    return {
      body: rawBody,
      changed: false,
      metric: {
        mode: "observe",
        outcome: "observed",
        ruleId: RULE_ID,
        eligibleToolResultCount: candidates.length,
        transformedToolResultCount: 0,
        inputUtf8BytesBefore: beforeBytes,
        inputUtf8BytesAfter: beforeBytes,
        reducedUtf8Bytes: 0,
      },
    };
  }

  const allowlist = new Set(config.toolResultEnvelope.allowlistedToolNames);
  let transformed = 0;
  for (const c of candidates) {
    if (!allowlist.has(c.toolName)) continue;
    const originalBytes = Buffer.byteLength(c.text, "utf8");
    if (originalBytes < config.toolResultEnvelope.minInputUtf8Bytes) continue;
    const envelope = makeToolResultEnvelope({
      toolName: c.toolName,
      text: c.text,
      preservedHeadUtf8Bytes: config.toolResultEnvelope.preservedHeadUtf8Bytes,
      preservedTailUtf8Bytes: config.toolResultEnvelope.preservedTailUtf8Bytes,
    });
    if (Buffer.byteLength(envelope, "utf8") >= originalBytes) continue;
    c.replace(envelope);
    transformed += 1;
  }

  if (transformed === 0) {
    return {
      body: rawBody,
      changed: false,
      metric: {
        mode: "envelope",
        outcome: "bypassed_ineligible",
        ruleId: RULE_ID,
        eligibleToolResultCount: candidates.length,
        transformedToolResultCount: 0,
        inputUtf8BytesBefore: beforeBytes,
        inputUtf8BytesAfter: beforeBytes,
        reducedUtf8Bytes: 0,
      },
    };
  }

  const after = Buffer.from(JSON.stringify(parsed), "utf8");
  if (after.byteLength >= beforeBytes) {
    return {
      body: rawBody,
      changed: false,
      metric: {
        mode: "envelope",
        outcome: "bypassed_ineligible",
        ruleId: RULE_ID,
        eligibleToolResultCount: candidates.length,
        transformedToolResultCount: 0,
        inputUtf8BytesBefore: beforeBytes,
        inputUtf8BytesAfter: beforeBytes,
        reducedUtf8Bytes: 0,
      },
    };
  }
  return {
    body: after,
    changed: true,
    metric: {
      mode: "envelope",
      outcome: "transformed",
      ruleId: RULE_ID,
      eligibleToolResultCount: candidates.length,
      transformedToolResultCount: transformed,
      inputUtf8BytesBefore: beforeBytes,
      inputUtf8BytesAfter: after.byteLength,
      reducedUtf8Bytes: beforeBytes - after.byteLength,
    },
  };
}

interface Candidate {
  toolName: string;
  text: string;
  replace(next: string): void;
}

function collectToolUseNames(root: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const messages = getMessages(root);
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of getContentBlocks(message.content)) {
      if (!isRecord(block)) continue;
      if (block.type !== "tool_use") continue;
      if (typeof block.id === "string" && typeof block.name === "string") {
        out.set(block.id, block.name);
      }
    }
  }
  return out;
}

function findToolResultCandidates(root: unknown, toolNamesById: Map<string, string>): Candidate[] {
  const out: Candidate[] = [];
  const messages = getMessages(root);
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type !== "tool_result") continue;
      if (block.is_error === true) continue;
      if (typeof block.tool_use_id !== "string") continue;
      const toolName = toolNamesById.get(block.tool_use_id);
      if (!toolName) continue;
      const text = plainTextToolResultContent(block.content);
      if (text === null) continue;
      out.push({
        toolName,
        text,
        replace(next: string): void {
          block.content = next;
        },
      });
    }
  }
  return out;
}

function getMessages(root: unknown): Array<Record<string, unknown>> {
  if (!isRecord(root) || !Array.isArray(root.messages)) return [];
  return root.messages.filter(isRecord);
}

function getContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  return [];
}

function plainTextToolResultContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) return null;
    if (block.type !== "text" || typeof block.text !== "string") return null;
    parts.push(block.text);
  }
  return parts.join("");
}

function makeToolResultEnvelope(input: {
  toolName: string;
  text: string;
  preservedHeadUtf8Bytes: number;
  preservedTailUtf8Bytes: number;
}): string {
  const originalBytes = Buffer.byteLength(input.text, "utf8");
  const head = utf8Prefix(input.text, input.preservedHeadUtf8Bytes);
  const tail = utf8Suffix(input.text, input.preservedTailUtf8Bytes);
  const retainedBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  const omitted = Math.max(0, originalBytes - retainedBytes);
  const digest = crypto.createHash("sha256").update(input.text).digest("hex");
  return [
    ENVELOPE_MARKER,
    `tool: ${input.toolName}`,
    `original_utf8_bytes: ${originalBytes}`,
    `content_sha256: ${digest}`,
    "preserved_head:",
    head,
    "",
    "preserved_tail:",
    tail,
    "",
    `omitted_utf8_bytes: ${omitted}`,
    "note: This result was compacted by an explicitly enabled experimental Tierkit gateway transformation.",
  ].join("\n");
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const chars = Array.from(text);
  let out = "";
  let bytes = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]!;
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    out = ch + out;
    bytes += n;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
