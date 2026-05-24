import fs from "node:fs/promises";
import path from "node:path";

export interface McpActivityInput {
  tool: string;
  ok: boolean;
  code: string | null;
  durationMs: number;
  redactionHits: number;
  inputSummary: unknown;   // tool-specific; MUST be path-basename / counts only
  outputSummary: unknown;  // tool-specific; MUST be sizes / counts only
  /**
   * Envelope metadata extracted from the tool result. Optional — only present
   * for tools that use tool-result-envelope.v1 (v0.16+).
   */
  envelope?: {
    truncated: boolean;
    hasCursor: boolean;
    remainingLines?: number;
  };
  /**
   * v0.23: the MCP client's self-reported name (from initialize handshake).
   * Sourced from server.getClientVersion()?.name. Common values: "claude-code",
   * "codex", "Cursor". Used by tierkitSavings to bucket savings per client.
   * Optional for forward compat with older activity log entries.
   */
  clientName?: string;
}

export interface McpActivityEntry extends McpActivityInput {
  ts: string;
  type: "mcp-tool";
  workspaceRoot: string;   // populated by logMcpActivity from its first arg
}

const LOG_REL = ".tierkit/runtime/usage.jsonl";

type ActivityListener = (workspaceRoot: string) => void;
let activityListener: ActivityListener | null = null;

/**
 * Register a fire-and-forget callback that runs after each logMcpActivity
 * append. Used by the runtime's savingsBroadcaster to push SSE events on
 * every MCP tool call without activityLog (mcp/) importing runtime/.
 *
 * Pass null to clear.
 */
export function setActivityListener(fn: ActivityListener | null): void {
  activityListener = fn;
}

export async function logMcpActivity(workspaceRoot: string, input: McpActivityInput): Promise<void> {
  const entry: McpActivityEntry = {
    ts: new Date().toISOString(),
    type: "mcp-tool",
    workspaceRoot,
    ...input,
  };
  const file = path.join(workspaceRoot, LOG_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Append-only. JSONL: one line per entry.
  await fs.appendFile(file, JSON.stringify(entry) + "\n");
  // Fire-and-forget. Listener exceptions must not propagate — broadcaster
  // failure must not corrupt the MCP tool's response path.
  if (activityListener) {
    try { activityListener(workspaceRoot); }
    catch (err) { console.error("[tierkit] activityListener threw:", err); }
  }
}

export async function readMcpActivity(workspaceRoot: string): Promise<McpActivityEntry[]> {
  const file = path.join(workspaceRoot, LOG_REL);
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (err: any) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out: McpActivityEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as McpActivityEntry); }
    catch { /* malformed line — forward-compat skip */ }
  }
  return out;
}
