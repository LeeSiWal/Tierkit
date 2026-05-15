import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "@tierkit/core";
import { TierkitClient, TierkitClientError } from "../src/index.js";

async function makeProject(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-client-test-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

describe("TierkitClient", () => {
  let root: string;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function boot(config: object): Promise<TierkitClient> {
    root = await makeProject(config);
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0 });
    return new TierkitClient({ baseUrl: `http://127.0.0.1:${server.port}` });
  }

  it("health() returns the daemon version + cwd", async () => {
    const client = await boot({
      version: "0.1",
      modelProfiles: { localFast: { kind: "local-device", provider: "ollama", model: "x" } },
    });
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(typeof h.version).toBe("string");
  });

  it("routeExplain() returns the decision JSON", async () => {
    const client = await boot({
      version: "0.1",
      modelProfiles: { localFast: { kind: "local-device", provider: "ollama", model: "x" } },
    });
    const r = await client.routeExplain({ task: "rename a helper" });
    expect(r.decision.tier).toBe("local-device");
  });

  it("checkCommand('rm -rf /') returns severity=block", async () => {
    const client = await boot({ version: "0.1", modelProfiles: {} });
    const r = await client.checkCommand("rm -rf /");
    expect(r.severity).toBe("block");
  });

  it("checkPath('.env') flags sensitive", async () => {
    const client = await boot({ version: "0.1", modelProfiles: {} });
    const r = await client.checkPath(".env");
    expect(r.sensitive).toBe(true);
  });

  it("redact() returns the redacted text + hits", async () => {
    const client = await boot({ version: "0.1", modelProfiles: {} });
    const r = await client.redact("key=sk-abcdefghijklmnopqrstuvw0");
    expect(r.text).toContain("[REDACTED:openai-api-key]");
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("llmCall() returns a typed result; failures come back as ok=false (HTTP 400)", async () => {
    const client = await boot({ version: "0.1", modelProfiles: {} });
    const r = await client.llmCall({ profileId: "ghost", messages: [{ role: "user", content: "x" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown-profile");
  });

  it("usage() returns records + summary", async () => {
    const client = await boot({ version: "0.1", modelProfiles: {} });
    const r = await client.usage();
    expect(Array.isArray(r.records)).toBe(true);
    expect(r.summary.totalCalls).toBe(0);
  });

  it("budget() returns the current status", async () => {
    const client = await boot({
      version: "0.1",
      modelProfiles: {},
      budget: { dailyUsdLimit: 5, warnAtPercent: 70, blockAtPercent: 100 },
    });
    const r = await client.budget();
    expect(r.status).toBe("ok");
    expect(r.dailyLimitUsd).toBe(5);
  });

  it("connection refused yields TierkitClientError with code='network-error'", async () => {
    const client = new TierkitClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.health()).rejects.toBeInstanceOf(TierkitClientError);
  });

  it("session lifecycle: start → approve-plan → advance → abandon", async () => {
    const client = await boot({ version: "0.1", modelProfiles: {} });
    const initial = await client.session();
    expect(initial.session).toBeNull();
    const started = await client.sessionStart("rename a helper");
    expect((started as { session: { state: string } }).session.state).toBe("planning");
    const approved = await client.sessionApprovePlan();
    expect((approved as { planApproved: boolean }).planApproved).toBe(true);
    const advanced = await client.sessionAdvance("implementing");
    expect((advanced as { state: string }).state).toBe("implementing");
    const abandoned = await client.sessionAbandon();
    expect((abandoned as { state: string }).state).toBe("abandoned");
  });

  it("models() returns the profiles listed in config", async () => {
    const client = await boot({
      version: "0.1",
      modelProfiles: { localFast: { kind: "local-device", provider: "ollama", model: "x" } },
    });
    const r = await client.models();
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.id).toBe("localFast");
  });

  it("llmCallStream() yields start → (delta) → usage → end for a successful response (mocked)", async () => {
    // Use a custom fetch that returns a synthetic ok response so we don't need a real provider.
    const client = new TierkitClient({
      baseUrl: "http://127.0.0.1:0",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            text: "hello",
            inputTokens: 4,
            outputTokens: 2,
            costUsd: 0,
            latencyMs: 12,
            profileId: "x",
            model: "m",
            redactionHits: [],
            commandClassifications: [],
            budget: { status: "ok" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const events: string[] = [];
    for await (const evt of client.llmCallStream({ profileId: "x", messages: [] })) {
      events.push(evt.type);
    }
    expect(events).toEqual(["start", "delta", "usage", "end"]);
  });
});
