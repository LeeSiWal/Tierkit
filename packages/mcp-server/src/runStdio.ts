import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type CreateMcpServerOptions } from "./server.js";

/**
 * Run the MCP server on stdio. Blocks until the parent disconnects.
 * Logs go to stderr; stdout is reserved for MCP JSON-RPC framing.
 *
 * Shutdown signal — pick the first that's available in the installed SDK:
 *   1. transport.onclose (or whatever the SDK calls its lifecycle hook)
 *   2. a promise returned by server.connect() / transport.start()
 *   3. fallback below: process.stdin end/close
 */
export async function runMcpStdio(opts: CreateMcpServerOptions): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // PREFERRED (replace this block if the SDK exposes a close-promise):
  // await new Promise<void>((resolve) => {
  //   (transport as any).onclose = () => resolve();
  // });

  // FALLBACK (portable but slightly weaker — settles when the parent's
  // stdin closes, which in stdio JSON-RPC is effectively the disconnect):
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });

  await server.close();
}
