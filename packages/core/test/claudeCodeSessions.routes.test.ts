import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/index.js";

describe("GET /v1/claude-code/sessions[/:id]", () => {
  let server: RunningServer;
  let home: string;
  let workspace: string;
  let baseUrl: string;
  const realId = "11111111-2222-3333-4444-555555555555";

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-srv-ccs-"));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tk-srv-ccs-ws-"));
    const dir = path.join(home, ".claude", "projects", workspace.replace(/[/.]/g, "-"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${realId}.jsonl`),
      [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      ].join("\n"),
    );
    server = await startServer({ cwd: workspace, host: "127.0.0.1", port: 0, adapters: {}, homeDir: home });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("GET /sessions returns the seeded session", async () => {
    const r = await fetch(`${baseUrl}/v1/claude-code/sessions`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.sessions[0]?.id).toBe(realId);
  });

  it("GET /sessions/:id returns the parsed message thread", async () => {
    const r = await fetch(`${baseUrl}/v1/claude-code/sessions/${realId}`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  it("GET /sessions/:id returns 404 for missing session", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/99999999-9999-9999-9999-999999999999`);
    expect(res.status).toBe(404);
  });

  it("GET /sessions/:id returns 400 for malformed id", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it("GET /sessions/:id rejects path traversal", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/${encodeURIComponent("../etc/passwd")}`);
    expect(res.status).toBe(400);
  });
});
