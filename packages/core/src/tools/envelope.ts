export const TOOL_RESULT_ENVELOPE_VERSION = "tool-result-envelope.v1" as const;
export type ToolResultEnvelopeVersion = typeof TOOL_RESULT_ENVELOPE_VERSION;

export interface ToolResultRange {
  startLine?: number;
  endLine?: number;
  startByte?: number;
  endByte?: number;
}

export interface ToolResultSize {
  bytesReturned?: number;
  totalBytes?: number;
  remainingBytes?: number;
  linesReturned?: number;
  totalLines?: number;
  remainingLines?: number;
  // Stream-prefixed fields for run_command (see spec §B.4):
  stdoutBytesReturned?: number;
  stderrBytesReturned?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface ToolResultNext {
  cursor: string;
  suggestedCall: {
    tool: string;
    args: Record<string, unknown>;
  };
}

export interface CompactContextMetadata {
  version: "tierkit-compact-context.v1";
  contextId: string;
  contentDigest: string;
  sourceKind: "file_digest" | "symbol_context" | "diff_context" | "test_failure_summary" | "context_pack" | "other_compact_tool";
  recoverable: boolean;
  retrieveMoreTool: string | null;
  measurementTicket: string | null;
}

export interface ToolResultSuccess<TData> {
  ok: true;
  tool: string;
  version: ToolResultEnvelopeVersion;
  data: TData;
  truncated: boolean;
  range?: ToolResultRange;
  size?: ToolResultSize;
  next?: ToolResultNext;
  warnings?: string[];
  compactContext?: CompactContextMetadata;
}

export interface ToolResultFailure {
  ok: false;
  tool: string;
  version: ToolResultEnvelopeVersion;
  error: {
    code: string;
    message: string;
  };
  warnings?: string[];
}

export type ToolResultEnvelope<TData = unknown> =
  | ToolResultSuccess<TData>
  | ToolResultFailure;

export interface MakeSuccessOptions {
  truncated?: boolean;
  range?: ToolResultRange;
  size?: ToolResultSize;
  next?: ToolResultNext;
  warnings?: string[];
  compactContext?: CompactContextMetadata;
}

export function makeSuccessEnvelope<TData>(
  tool: string,
  data: TData,
  opts: MakeSuccessOptions = {},
): ToolResultSuccess<TData> {
  const env: ToolResultSuccess<TData> = {
    ok: true,
    tool,
    version: TOOL_RESULT_ENVELOPE_VERSION,
    data,
    truncated: opts.truncated ?? false,
  };
  if (opts.range) env.range = opts.range;
  if (opts.size) env.size = opts.size;
  if (opts.next) env.next = opts.next;
  if (opts.warnings && opts.warnings.length > 0) env.warnings = opts.warnings;
  if (opts.compactContext) env.compactContext = opts.compactContext;
  return env;
}

export function makeFailureEnvelope(
  tool: string,
  code: string,
  message: string,
  warnings?: string[],
): ToolResultFailure {
  const env: ToolResultFailure = {
    ok: false,
    tool,
    version: TOOL_RESULT_ENVELOPE_VERSION,
    error: { code, message },
  };
  if (warnings && warnings.length > 0) env.warnings = warnings;
  return env;
}
