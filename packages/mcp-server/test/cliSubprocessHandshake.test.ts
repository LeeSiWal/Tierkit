import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM has no __dirname; derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("tierkit mcp serve — subprocess handshake", () => {
  it("initializes and lists tools over real stdio", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcp-cli-"));
    const transport = new StdioClientTransport({
      command: "node",
      args: [
        path.resolve(__dirname, "../../cli/dist/index.js"),
        "mcp", "serve", "--workspace", workspace,
      ],
    });
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(14);
    await client.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 15000);
});
