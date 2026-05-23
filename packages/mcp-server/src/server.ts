import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logMcpActivity, TIERKIT_VERSION } from "@tierkit/core";
import { listFilesTool } from "./tools/listFiles.js";
import { readFileTool } from "./tools/readFile.js";
import { codebaseSearchTool } from "./tools/codebaseSearch.js";
import { proposePatchTool } from "./tools/proposePatch.js";
import { applyPatchTool } from "./tools/applyPatch.js";
import { runCommandTool } from "./tools/runCommand.js";
import { getPolicyStatusTool } from "./tools/getPolicyStatus.js";
import {
  compressCommandTool,
  getErrorDigestTool,
  getTestDigestTool,
  getJsonDigestTool,
  getFileDigestTool,
  getDiffSummaryTool,
  buildContextPackTool,
} from "./tools/digestTools.js";
import { countHits } from "./redactOutput.js";

export interface CreateMcpServerOptions {
  workspaceRoot: string;
  env?: Record<string, string | undefined>;
}

export const TOOL_NAMES = [
  "tierkit.list_files",
  "tierkit.read_file",
  "tierkit.codebase_search",
  "tierkit.propose_patch",
  "tierkit.apply_patch",
  "tierkit.run_command",
  "tierkit.get_policy_status",
  // v0.18 context-gateway digest tools
  "tierkit.compress_command",
  "tierkit.get_error_digest",
  "tierkit.get_test_digest",
  "tierkit.get_json_digest",
  "tierkit.get_file_digest",
  "tierkit.get_diff_summary",
  "tierkit.build_context_pack",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

interface ToolCallContext {
  workspaceRoot: string;
  clientName?: string;
}

// ToolEnvelope covers both the legacy ad-hoc shape (propose_patch, apply_patch,
// get_policy_status) and the v0.16 tool-result-envelope.v1 shape returned by
// the migrated tools (read_file, list_files, codebase_search, run_command).
// We use `any` here because the strict envelope types from @tierkit/core do not
// carry an index signature, so they can't be directly assigned to a mapped type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolEnvelope = any;

function notImplemented(name: string): ToolEnvelope {
  return { ok: false, code: "not-implemented", message: `${name} not wired yet` };
}

// ---- dispatch ----
//
// Later phases add branches here. Do NOT wrap individual branches in try/catch
// or write to the activity log directly — that's withActivityLog's job.
async function dispatchTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<ToolEnvelope> {
  switch (name) {
    // Phase 3 fills these in:
    case "tierkit.list_files":
      return listFilesTool({
        workspaceRoot: ctx.workspaceRoot,
        path: typeof args.path === "string" ? args.path : undefined,
        recursive: args.recursive === true,
        maxEntries: typeof args.maxEntries === "number" ? args.maxEntries : undefined,
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      });
    case "tierkit.read_file":
      return readFileTool({
        workspaceRoot: ctx.workspaceRoot,
        path: typeof args.path === "string" ? args.path : undefined,
        startLine: typeof args.startLine === "number" ? args.startLine : undefined,
        maxLines: typeof args.maxLines === "number" ? args.maxLines : undefined,
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      });
    case "tierkit.codebase_search":
      return codebaseSearchTool({
        workspaceRoot: ctx.workspaceRoot,
        query: typeof args.query === "string" ? args.query : undefined,
        path: typeof args.path === "string" ? args.path : undefined,
        maxMatches: typeof args.maxMatches === "number" ? args.maxMatches : undefined,
        contextLines: typeof args.contextLines === "number" ? args.contextLines : undefined,
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      });
    // Phase 4-5 fill these in:
    case "tierkit.propose_patch":
      return proposePatchTool({
        workspaceRoot: ctx.workspaceRoot,
        files: Array.isArray(args.files) ? args.files as any : [],
        note: typeof args.note === "string" ? args.note : undefined,
        proposedBy: typeof args.proposedBy === "string" ? args.proposedBy : undefined,
      });
    case "tierkit.apply_patch":
      return applyPatchTool({ workspaceRoot: ctx.workspaceRoot, patchId: args.patchId as string });
    // Phase 6:
    case "tierkit.run_command":
      return runCommandTool({
        workspaceRoot: ctx.workspaceRoot,
        command: typeof args.command === "string" ? args.command : "",
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      });
    case "tierkit.get_policy_status":
      return getPolicyStatusTool({ workspaceRoot: ctx.workspaceRoot });
    // v0.18 digest tools — thin wrappers around @tierkit/core
    case "tierkit.compress_command":
      return compressCommandTool(args, { workspaceRoot: ctx.workspaceRoot });
    case "tierkit.get_error_digest":
      return getErrorDigestTool(args, { workspaceRoot: ctx.workspaceRoot });
    case "tierkit.get_test_digest":
      return getTestDigestTool(args, { workspaceRoot: ctx.workspaceRoot });
    case "tierkit.get_json_digest":
      return getJsonDigestTool(args, { workspaceRoot: ctx.workspaceRoot });
    case "tierkit.get_file_digest":
      return getFileDigestTool(args, { workspaceRoot: ctx.workspaceRoot });
    case "tierkit.get_diff_summary":
      return getDiffSummaryTool(args, { workspaceRoot: ctx.workspaceRoot });
    case "tierkit.build_context_pack":
      return buildContextPackTool(args, { workspaceRoot: ctx.workspaceRoot });
    default:
      return notImplemented(name);
  }
}

// ---- per-tool summarizers ----
//
// Each summarizer returns ONLY safe-to-log fields (basenames, counts, sizes).
// NEVER include file bodies, env values, full command lines, or redacted text.
// Later phases extend these as new tools land.
function summarizeInput(name: ToolName, args: Record<string, unknown>): unknown {
  switch (name) {
    case "tierkit.read_file":         return { path: pathBasename(args.path), encoding: args.encoding ?? "utf8" };
    case "tierkit.list_files":        return { path: pathBasename(args.path), recursive: Boolean(args.recursive) };
    case "tierkit.codebase_search":   return { queryLength: stringLen(args.query) };
    case "tierkit.propose_patch":     return { fileCount: Array.isArray(args.files) ? args.files.length : 0 };
    case "tierkit.apply_patch":       return { patchId: args.patchId };
    case "tierkit.run_command":       return { commandLength: stringLen(args.command), hasTimeout: typeof args.timeoutMs === "number" };
    case "tierkit.get_policy_status": return null;
    case "tierkit.compress_command":  return { commandLength: stringLen(args.command) };
    case "tierkit.get_error_digest":  return { logLength: stringLen(args.log) };
    case "tierkit.get_test_digest":   return { outputLength: stringLen(args.output) };
    case "tierkit.get_json_digest":   return { jsonLength: stringLen(args.json) };
    case "tierkit.get_file_digest":   return { path: pathBasename(args.path), forceRefresh: args.forceRefresh === true };
    case "tierkit.get_diff_summary":  return { staged: args.staged === true };
    case "tierkit.build_context_pack":return {
      commandLength: stringLen(args.command),
      fileCount: Array.isArray(args.files) ? args.files.length : 0,
      includeDiff: args.includeDiff === true,
      hasError: typeof args.errorLog === "string",
      hasTest: typeof args.testOutput === "string",
      hasJson: typeof args.jsonInput === "string",
      hasRaw: typeof args.rawContext === "string",
    };
    default:                          return null;
  }
}

function summarizeOutput(name: ToolName, result: ToolEnvelope): unknown {
  // Sizes and counts only. Never the actual content.
  if (!result) return null;
  // get_policy_status is safe to log on both success and failure (count only).
  if (name === "tierkit.get_policy_status") {
    return { pendingPatches: result.pendingPatches };
  }
  // For everything else, content-bearing results — only log on success
  if (result.ok === false) return null;
  switch (name) {
    // v0.16 envelope tools: data lives under result.data
    case "tierkit.read_file": {
      const data = result.data;
      return {
        bytes: stringLen(data?.content),
        path: pathBasename(data?.path),
      };
    }
    case "tierkit.list_files": {
      const data = result.data;
      return {
        count: Array.isArray(data?.entries) ? data.entries.length : 0,
      };
    }
    case "tierkit.codebase_search": {
      const data = result.data;
      return {
        hits: Array.isArray(data?.matches) ? data.matches.length : 0,
      };
    }
    case "tierkit.run_command": {
      const data = result.data;
      const size = result.size;
      return {
        exitCode: data?.exitCode,
        stdoutBytes: size?.stdoutBytesReturned,
        stderrBytes: size?.stderrBytesReturned,
        truncated: Boolean(result.truncated),
      };
    }
    // Non-envelope tools (propose_patch, apply_patch) still read top-level fields
    case "tierkit.propose_patch":     return { patchId: result.patchId, riskLevel: (result.risk as any)?.level };
    case "tierkit.apply_patch":       return { fileCount: Array.isArray(result.files) ? result.files.length : 0 };
    // v0.18 digest envelopes — log compression stats only, never content.
    case "tierkit.compress_command":
    case "tierkit.get_error_digest":
    case "tierkit.get_test_digest":
    case "tierkit.get_json_digest":
    case "tierkit.get_file_digest":
    case "tierkit.get_diff_summary":
    case "tierkit.build_context_pack": {
      const data = result.data;
      return {
        beforeTokens: data?.stats?.beforeTokens,
        afterTokens: data?.stats?.afterTokens,
        savedTokens: data?.stats?.savedTokens,
      };
    }
    default:                          return null;
  }
}

/**
 * Extract activity-log envelope metadata from a tool result. Returns undefined
 * for non-envelope results (e.g. propose_patch / apply_patch / get_policy_status
 * which don't migrate to envelope in v0.16).
 */
function summarizeEnvelope(result: ToolEnvelope): { truncated: boolean; hasCursor: boolean; remainingLines?: number } | undefined {
  if (!result || typeof result !== "object") return undefined;
  if (result.version !== "tool-result-envelope.v1") return undefined;
  return {
    truncated: Boolean(result.truncated),
    hasCursor: Boolean(result.next?.cursor),
    remainingLines: typeof result.size?.remainingLines === "number" ? result.size.remainingLines : undefined,
  };
}

function pathBasename(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function stringLen(s: unknown): number {
  return typeof s === "string" ? s.length : 0;
}

// ---- the activity-log wrapper ----
//
// Runs the dispatcher, captures success/failure shape, logs exactly once,
// and translates the envelope to the MCP response shape. Logging failures
// MUST NOT propagate — a broken disk should never poison the tool call.
async function withActivityLog(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  const startedAt = Date.now();
  let result: ToolEnvelope;
  let ok = true;
  let code: string | null = null;
  try {
    result = await dispatchTool(name, args, ctx);
    if (result && result.ok === false) {
      ok = false;
      // v0.16 envelope tools use result.error.code; legacy tools use result.code
      code = result.error?.code ?? result.code ?? "unknown";
    }
  } catch (err: any) {
    ok = false;
    code = "thrown";
    result = { ok: false, code: "thrown", message: String(err?.message ?? err) };
  }
  const redactionHits = typeof result.redactionHits === "number"
    ? result.redactionHits
    : Array.isArray(result.redactionHits)
      ? countHits(result.redactionHits as Parameters<typeof countHits>[0])
      : 0;

  await logMcpActivity(ctx.workspaceRoot, {
    tool: name,
    ok,
    code,
    durationMs: Date.now() - startedAt,
    redactionHits,
    inputSummary: summarizeInput(name, args),
    outputSummary: summarizeOutput(name, result),
    envelope: summarizeEnvelope(result),   // v0.16: envelope metadata
    clientName: ctx.clientName,            // v0.23: per-client savings attribution
  }).catch(() => { /* swallow — never fail a tool call because logging failed */ });

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: !ok,
  };
}

export function createMcpServer(opts: CreateMcpServerOptions): Server {
  const server = new Server(
    { name: "tierkit", version: TIERKIT_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: `Tierkit-gated ${name.replace("tierkit.", "")}`,
      inputSchema: { type: "object", additionalProperties: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name as ToolName;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const ci = server.getClientVersion();
    const clientName = (ci?.name ?? "unknown").toString();
    return withActivityLog(name, args, { workspaceRoot: opts.workspaceRoot, clientName });
  });

  return server;
}
