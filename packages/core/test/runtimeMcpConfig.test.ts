import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

describe("GET /v1/mcp/config", () => {
  let root: string;
  let server: RunningServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the suggested mcpServers JSON for the current workspace", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcpcfg-"));
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(root, ".tierkit", "plugins.json"), JSON.stringify({ version: "0.1", plugins: [] }));
    await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify({ version: "0.1", modelProfiles: {} }));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/mcp/config`);
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.mcpServers).toBeDefined();
    expect(json.mcpServers.tierkit.type).toBe("stdio");
    expect(json.mcpServers.tierkit.command).toBe("tierkit");
    expect(json.mcpServers.tierkit.args).toEqual([
      "mcp", "serve", "--workspace", await fs.realpath(root),
    ]);
  });

  it("supports ?format=claude-code", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcpcfg2-"));
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(root, ".tierkit", "plugins.json"), JSON.stringify({ version: "0.1", plugins: [] }));
    await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify({ version: "0.1", modelProfiles: {} }));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/mcp/config?format=claude-code`);
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.mcpServers.tierkit.type).toBe("stdio");
  });
});
