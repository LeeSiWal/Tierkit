import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import { GENERATE_PLUGIN_EXAMPLE_JSON } from "../src/usecases/generatePluginExample.js";
import * as llmCallModule from "../src/runtime/proxy/llmCall.js";

let tmp: string;
let server: RunningServer | undefined;

async function boot() {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-genplugin-ep-"));
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        localFake: { kind: "local-device", provider: "mock", model: "tiny", roles: [] },
      },
      routingPolicy: { autoEscalationCeiling: "local-device" },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  return `http://${server.address}:${server.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { await server.close(); server = undefined; }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("POST /v1/plugins/generate", () => {
  it("returns draftId + manifest when LLM returns valid JSON", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true,
      text: GENERATE_PLUGIN_EXAMPLE_JSON,
      inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "localFake", model: "tiny",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "TDD-first python" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; draftId: string; manifest: { id: string }; rules: unknown[]; modelUsed: string };
    expect(body.ok).toBe(true);
    expect(body.draftId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.manifest.id).toBe("tdd-first-python");
    expect(body.rules.length).toBe(3);
    expect(body.modelUsed).toBe("localFake");
  });

  it("returns 400 with empty description", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 + code='validation-failed' + rawOutput when LLM consistently produces invalid JSON", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true, text: "not json", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { ok: boolean; code: string; rawOutput: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("validation-failed");
    expect(body.rawOutput).toBe("not json");
  });
});

describe("POST /v1/plugins/generate/install", () => {
  it("promotes a draft to an installed plugin", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true, text: GENERATE_PLUGIN_EXAMPLE_JSON, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const baseUrl = await boot();
    const gen = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    }).then((r) => r.json()) as { draftId: string };
    const ins = await fetch(`${baseUrl}/v1/plugins/generate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftId: gen.draftId, enable: false }),
    });
    expect(ins.status).toBe(200);
    const body = await ins.json() as { ok: boolean; pluginId: string };
    expect(body.ok).toBe(true);
    expect(body.pluginId).toBe("tdd-first-python");

    // Draft is cleaned up.
    const draftExists = await fs.access(path.join(tmp, ".tierkit", "plugin-drafts", gen.draftId))
      .then(() => true).catch(() => false);
    expect(draftExists).toBe(false);
  });

  it("returns 404 for an unknown draftId", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftId: "00000000-0000-0000-0000-000000000000", enable: false }),
    });
    expect(r.status).toBe(404);
  });
});
