import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logMcpActivity } from "@tierkit/core";
import { listFilesTool } from "./tools/listFiles.js";
import { readFileTool } from "./tools/readFile.js";
import { codebaseSearchTool } from "./tools/codebaseSearch.js";
import { proposePatchTool } from "./tools/proposePatch.js";
import { applyPatchTool } from "./tools/applyPatch.js";
import { countHits } from "./redactOutput.js";

export interface CreateMcpServerOptions {
  workspaceRoot: string;
  env?: Record<string, string | undefined>;
}

const TOOL_NAMES = [
  "tierkit.list_files",
  "tierkit.read_file",
  "tierkit.codebase_search",
  "tierkit.propose_patch",
  "tierkit.apply_patch",
  "tierkit.run_command",
  "tierkit.get_policy_status",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

interface ToolCallContext {
  workspaceRoot: string;
}

interface ToolEnvelope {
  // Per-tool functions return JSON-serializable results. ok/code/redactionHits
  // are conventions used to derive activity-log fields.
  // redactionHits may be a number (legacy/simple) or an array of { ruleId, count }
  // objects (from tools that use redactOutput). withActivityLog handles both.
  ok?: boolean;
  code?: string;
  redactionHits?: number | Array<{ ruleId: string; count: number }>;
  [k: string]: unknown;
}

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
        path: typeof args.path === "string" ? args.path : ".",
        recursive: args.recursive === true,
      });
    case "tierkit.read_file":
      return readFileTool({
        workspaceRoot: ctx.workspaceRoot,
        path: typeof args.path === "string" ? args.path : "",
        maxBytes: typeof args.maxBytes === "number" ? args.maxBytes : undefined,
      });
    case "tierkit.codebase_search":
      return codebaseSearchTool({
        workspaceRoot: ctx.workspaceRoot,
        query: typeof args.query === "string" ? args.query : "",
        maxMatches: typeof args.maxMatches === "number" ? args.maxMatches : undefined,
        contextLines: typeof args.contextLines === "number" ? args.contextLines : undefined,
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
    // Phase 6 fills these in:
    case "tierkit.run_command":       return notImplemented(name);
    case "tierkit.get_policy_status": return notImplemented(name);
    default:                          return notImplemented(name);
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
    default:                          return null;
  }
}

function summarizeOutput(name: ToolName, result: ToolEnvelope): unknown {
  // Sizes and counts only. Never the actual content.
  if (!result) return null;
  // get_policy_status's count is safe to log even on failure
  if (name === "tierkit.get_policy_status") {
    return { pendingPatches: result.pendingPatches };
  }
  // For everything else, content-bearing results — only log on success
  if (result.ok === false) return null;
  switch (name) {
    case "tierkit.read_file":         return { bytes: stringLen(result.content), truncated: Boolean(result.truncated) };
    case "tierkit.list_files":        return { count: Array.isArray(result.entries) ? result.entries.length : 0 };
    case "tierkit.codebase_search":   return { hits: Array.isArray(result.matches) ? result.matches.length : 0 };
    case "tierkit.propose_patch":     return { patchId: result.patchId, riskLevel: (result.risk as any)?.level };
    case "tierkit.apply_patch":       return { fileCount: Array.isArray(result.files) ? result.files.length : 0 };
    case "tierkit.run_command":       return { exitCode: result.exitCode, truncated: Boolean(result.truncated) };
    default:                          return null;
  }
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
      code = result.code ?? "unknown";
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
  }).catch(() => { /* swallow — never fail a tool call because logging failed */ });

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: !ok,
  };
}

export function createMcpServer(opts: CreateMcpServerOptions): Server {
  const server = new Server(
    { name: "tierkit", version: "0.15.0" },
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
    return withActivityLog(name, args, { workspaceRoot: opts.workspaceRoot });
  });

  return server;
}
