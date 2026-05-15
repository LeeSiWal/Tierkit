import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

async function makeProject(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-server-session-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

describe("runtime Server — session endpoints + GUI", () => {
  let root: string;
  let server: RunningServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function boot(config: object): Promise<string> {
    root = await makeProject(config);
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0 });
    return `http://127.0.0.1:${server.port}`;
  }

  it("GET /v1/session returns null + effective freedom when no session", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`${url}/v1/session`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.session).toBeNull();
    expect(body.freedom).toBe("free");
  });

  it("POST /v1/session/start creates a session", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`${url}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "rename a helper" }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.session.state).toBe("planning");
    expect(body.session.task).toBe("rename a helper");
    const after = await (await fetch(`${url}/v1/session`)).json();
    expect(after.session.id).toBe(body.session.id);
  });

  it("POST /v1/session/start rejects empty task with 400", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`${url}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("approve-plan + advance progress the state machine", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    await fetch(`${url}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "x" }),
    });
    const approved = await (
      await fetch(`${url}/v1/session/approve-plan`, { method: "POST" })
    ).json();
    expect(approved.planApproved).toBe(true);
    expect(approved.state).toBe("planning");

    const advanced = await (
      await fetch(`${url}/v1/session/advance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toState: "implementing" }),
      })
    ).json();
    expect(advanced.state).toBe("implementing");
  });

  it("approve-plan returns 400 with code when no session", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`${url}/v1/session/approve-plan`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("no-session");
  });

  it("advance returns 400 with invalid-state on bad payload", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    await fetch(`${url}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "x" }),
    });
    const res = await fetch(`${url}/v1/session/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toState: "weird" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid-state");
  });

  it("abandon clears the current session pointer", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    await fetch(`${url}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "x" }),
    });
    const ab = await (await fetch(`${url}/v1/session/abandon`, { method: "POST" })).json();
    expect(ab.state).toBe("abandoned");
    const after = await (await fetch(`${url}/v1/session`)).json();
    expect(after.session).toBeNull();
  });

  it("GET /v1/models lists profiles", async () => {
    const url = await boot({
      version: "0.1",
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "x" },
      },
    });
    const r = await (await fetch(`${url}/v1/models`)).json();
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].id).toBe("localFast");
  });

  it("GET /v1/plugins lists installed plugins (empty by default)", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    const r = await (await fetch(`${url}/v1/plugins`)).json();
    expect(r.plugins).toEqual([]);
  });

  it("GET /v1/ui serves the GUI HTML page", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`${url}/v1/ui`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/<title>Tierkit<\/title>/);
    // The Mission Control UI hits these endpoints (no chat input — Tierkit is a policy
    // layer, not an agent). If you remove one of these the panel disappears, so the
    // test pinning them is intentional.
    expect(html).toContain("/v1/connections");
    expect(html).toContain("/v1/plugins");
    expect(html).toContain("/v1/usage");
    expect(html).toContain("/v1/models");
  });

  it("GET / also serves the GUI HTML (no need to type /v1/ui)", async () => {
    const url = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`${url}/`);
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain("Tierkit");
  });
});
