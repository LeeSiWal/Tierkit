import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

describe("/v1/mcp/patches HTTP surface", () => {
  let root: string;
  let server: RunningServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function start(): Promise<number> {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mcppatch-"));
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(root, ".tierkit", "plugins.json"), JSON.stringify({ version: "0.1", plugins: [] }));
    await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify({ version: "0.1", modelProfiles: {} }));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });
    return server.port;
  }

  async function makeProposed(): Promise<string> {
    // Seed a ticket directly via the core helper. Going through proposePatchTool
    // would force this test (which lives in @tierkit/core) to depend on
    // @tierkit/mcp-server, which in turn depends on @tierkit/core — circular.
    // The HTTP endpoint under test only needs a ticket on disk; the full propose
    // flow is exercised end-to-end in packages/mcp-server/test.
    const { createPatchTicket, writePatchPayload } = await import("../src/index.js");
    await fs.writeFile(path.join(root, "a.ts"), "old");
    const ticket = await createPatchTicket(root, {
      workspaceRoot: root,
      source: "mcp",
      proposedBy: "test",
      files: [{ path: "a.ts", beforeExists: true, beforeHash: "sha256:placeholder", afterHash: "sha256:placeholder" }],
      diff: "-- a.ts\n++ a.ts\n",
      risk: { level: "medium", reasons: ["test"] },
      requiresApproval: true,
    });
    await writePatchPayload(root, ticket.patchId, [{ index: 0, content: "new" }]);
    return ticket.patchId;
  }

  it("GET /v1/mcp/patches lists pending tickets", async () => {
    const port = await start();
    const id = await makeProposed();
    const r = await fetch(`http://127.0.0.1:${port}/v1/mcp/patches`);
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(Array.isArray(json.patches)).toBe(true);
    expect(json.patches[0].patchId).toBe(id);
  });

  it("POST /v1/mcp/patches/:id/approve flips approval.state", async () => {
    const port = await start();
    const id = await makeProposed();
    const r = await fetch(`http://127.0.0.1:${port}/v1/mcp/patches/${id}/approve`, { method: "POST" });
    expect(r.status).toBe(200);
    const { readPatchTicket } = await import("../src/index.js");
    const ticket = await readPatchTicket(root, id);
    expect(ticket.approval.state).toBe("approved");
    expect(ticket.approval.decidedBy).toBe("gui");
  });

  it("POST /v1/mcp/patches/:id/reject flips status + approval", async () => {
    const port = await start();
    const id = await makeProposed();
    const r = await fetch(`http://127.0.0.1:${port}/v1/mcp/patches/${id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "test reject" }),
    });
    expect(r.status).toBe(200);
    const { readPatchTicket } = await import("../src/index.js");
    const ticket = await readPatchTicket(root, id);
    expect(ticket.status).toBe("rejected");
    expect(ticket.approval.state).toBe("rejected");
    expect(ticket.approval.note).toBe("test reject");
  });

  it("rejects approve on a ticket that's already applied (state guard)", async () => {
    const port = await start();
    const id = await makeProposed();
    // Force status forward
    const { updatePatchTicket } = await import("../src/index.js");
    await updatePatchTicket(root, id, { status: "applied" });
    const r = await fetch(`http://127.0.0.1:${port}/v1/mcp/patches/${id}/approve`, { method: "POST" });
    expect(r.status).toBe(409);
  });

  it("404 on unknown patchId", async () => {
    const port = await start();
    const r = await fetch(`http://127.0.0.1:${port}/v1/mcp/patches/patch_does_not_exist/approve`, { method: "POST" });
    expect(r.status).toBe(404);
  });
});
