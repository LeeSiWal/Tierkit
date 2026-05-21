import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// Path confirmed by Task 1.0 spike: @modelcontextprotocol/sdk/inMemory.js
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

/** Helper: start a server+client pair and call one tool, then close both. */
async function callOneTool(
  workspaceRoot: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<void> {
  const server: Server = createMcpServer({ workspaceRoot });
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  // callTool may return isError:true (not-implemented) — that's fine for the smoke test.
  await client.callTool({ name: toolName, arguments: toolArgs });
  await client.close();
  await server.close();
}

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

  it("writes one activity-log line per tool call", async () => {
    const { readMcpActivity } = await import("@tierkit/core");
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-actlog-smoke-"));
    try {
      await callOneTool(workspace, "tierkit.list_files", {});

      const log = await readMcpActivity(workspace);
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[log.length - 1].tool).toBe("tierkit.list_files");
      expect(log[log.length - 1].workspaceRoot).toBe(workspace);
      expect(log[log.length - 1].type).toBe("mcp-tool");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("activity log carries envelope.{truncated,hasCursor,remainingLines} for envelope tools", async () => {
    const { readMcpActivity } = await import("@tierkit/core");
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-actlog-env-"));
    try {
      // Create a file large enough to trigger truncation (900 lines > 300 default maxLines)
      const big = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\n");
      await fs.writeFile(path.join(workspace, "big.ts"), big);

      await callOneTool(workspace, "tierkit.read_file", { path: "big.ts" });

      const log = await readMcpActivity(workspace);
      const lastEntry = log[log.length - 1];
      expect(lastEntry.envelope).toBeDefined();
      expect(lastEntry.envelope?.truncated).toBe(true);
      expect(lastEntry.envelope?.hasCursor).toBe(true);
      expect(lastEntry.envelope?.remainingLines).toBe(600);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
