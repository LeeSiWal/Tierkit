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
    // Claude's project-dir encoding rule (replace `/` and `.` with `-`) was
    // verified against macOS on-disk samples only. Windows paths (`C:\...`)
    // contain `\` and `:` that the rule doesn't address, and the upstream
    // encoder in src/usecases/listClaudeSessions.ts matches the macOS rule
    // exactly. Until we have a verified Windows convention, skip this HTTP
    // integration on win32; the encoder + scanner unit tests cover the same
    // logic with fake paths that work cross-platform.
    if (process.platform === "win32") return;
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
    if (server) await server.close();
  });

  // Vitest doesn't expose `describe.skipIf`, so we gate each test individually.
  // The beforeAll early-return left `server` undefined on Windows, so calling
  // through `${baseUrl}` would crash with a clearer skip than the asserts.
  const itPosix = process.platform === "win32" ? it.skip : it;

  itPosix("GET /sessions returns the seeded session", async () => {
    const r = await fetch(`${baseUrl}/v1/claude-code/sessions`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.sessions[0]?.id).toBe(realId);
  });

  itPosix("GET /sessions/:id returns the parsed message thread", async () => {
    const r = await fetch(`${baseUrl}/v1/claude-code/sessions/${realId}`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  itPosix("GET /sessions/:id returns 404 for missing session", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/99999999-9999-9999-9999-999999999999`);
    expect(res.status).toBe(404);
  });

  itPosix("GET /sessions/:id returns 400 for malformed id", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  itPosix("GET /sessions/:id rejects path traversal", async () => {
    const res = await fetch(`${baseUrl}/v1/claude-code/sessions/${encodeURIComponent("../etc/passwd")}`);
    expect(res.status).toBe(400);
  });
});
