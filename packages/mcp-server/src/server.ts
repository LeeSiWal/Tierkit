import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

export function createMcpServer(opts: CreateMcpServerOptions): Server {
  const server = new Server(
    { name: "tierkit", version: "0.15.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: `Tierkit-gated ${name.replace("tierkit.", "")} (placeholder; see v0.15 spec)`,
      inputSchema: { type: "object", additionalProperties: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: `not-implemented: ${req.params.name}` }],
    isError: true,
  }));

  void opts; // workspace + env consumed once tool handlers are wired in later phases
  return server;
}
