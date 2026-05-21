// SDK version: @modelcontextprotocol/sdk@1.29.0
// Resolved Server / StdioServerTransport / Client / StdioClientTransport: OK
// InMemoryTransport: @modelcontextprotocol/sdk/inMemory.js
// Action:
//   - InMemoryTransport is present → Task 1.2 uses it for the linked-pair handshake test.

import { describe, it, expect } from "vitest";

describe("MCP SDK import paths actually resolve at the installed version", () => {
  it("Server is importable", async () => {
    const m = await import("@modelcontextprotocol/sdk/server/index.js");
    expect(typeof m.Server).toBe("function");
  });
  it("StdioServerTransport is importable", async () => {
    const m = await import("@modelcontextprotocol/sdk/server/stdio.js");
    expect(typeof m.StdioServerTransport).toBe("function");
  });
  it("Client is importable", async () => {
    const m = await import("@modelcontextprotocol/sdk/client/index.js");
    expect(typeof m.Client).toBe("function");
  });
  it("StdioClientTransport is importable", async () => {
    const m = await import("@modelcontextprotocol/sdk/client/stdio.js");
    expect(typeof m.StdioClientTransport).toBe("function");
  });
  it("tools/list + tools/call schemas are importable", async () => {
    const m = await import("@modelcontextprotocol/sdk/types.js");
    expect(m.ListToolsRequestSchema).toBeDefined();
    expect(m.CallToolRequestSchema).toBeDefined();
  });
  it("in-memory transport: probe known candidate paths", async () => {
    const candidates = [
      "@modelcontextprotocol/sdk/inMemory.js",
      "@modelcontextprotocol/sdk/in-memory.js",
      "@modelcontextprotocol/sdk/shared/inMemory.js",
    ];
    const found: string[] = [];
    for (const c of candidates) {
      try {
        const m: any = await import(c);
        if (m.InMemoryTransport) found.push(c);
      } catch { /* not present at this path */ }
    }
    // Record which candidate(s) resolved. We do NOT fail if zero —
    // the SDK at this version may not ship an in-memory transport, in which
    // case Task 1.2 will use subprocess transport only and skip the in-memory test.
    console.log("[spike] InMemoryTransport found at:", found);
  });
});
