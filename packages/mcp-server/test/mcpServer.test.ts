import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// Path confirmed by Task 1.0 spike: @modelcontextprotocol/sdk/inMemory.js
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

describe("@tierkit/mcp-server — minimal handshake", () => {
  it("exposes the configured tool list", async () => {
    const server: Server = createMcpServer({
      workspaceRoot: process.cwd(),
    });
    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "tierkit.apply_patch",
      "tierkit.codebase_search",
      "tierkit.get_policy_status",
      "tierkit.list_files",
      "tierkit.propose_patch",
      "tierkit.read_file",
      "tierkit.run_command",
    ]);

    await client.close();
    await server.close();
  });
});
