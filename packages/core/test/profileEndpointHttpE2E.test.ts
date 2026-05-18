/** Tests the real HTTP endpoints (DELETE + PATCH) via a running startServer. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import * as discoverModule from "../src/model/discoverOllamaProfiles.js";

let tmp: string;
let server: RunningServer | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-http-e2e-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.TIERKIT_NO_DISCOVERY;
  vi.spyOn(discoverModule, "discoverOllamaProfiles").mockResolvedValue({
    "ollama-x": { kind: "local-device", provider: "ollama", model: "x:latest", baseUrl: "http://127.0.0.1:11434", roles: [], cost: { type: "free" } },
  });
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { await server.close(); server = undefined; }
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("HTTP DELETE /v1/config/profile/:id", () => {
  it("returns 200 and the profile disappears from /v1/models", async () => {
    const baseUrl = `http://${server!.address}:${server!.port}`;
    const before = await fetch(`${baseUrl}/v1/models`).then((r) => r.json()) as { entries: Array<{ id: string }> };
    expect(before.entries.some((e) => e.id === "ollama-x")).toBe(true);

    const del = await fetch(`${baseUrl}/v1/config/profile/ollama-x?scope=workspace`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const after = await fetch(`${baseUrl}/v1/models`).then((r) => r.json()) as { entries: Array<{ id: string }> };
    expect(after.entries.some((e) => e.id === "ollama-x")).toBe(false);
  });
});

describe("HTTP PATCH /v1/config/profile/:id with { enabled }", () => {
  it("toggles enabled state and reflects in /v1/models", async () => {
    const baseUrl = `http://${server!.address}:${server!.port}`;
    const before = await fetch(`${baseUrl}/v1/models`).then((r) => r.json()) as { entries: Array<{ id: string; profile: { enabled?: boolean } }> };
    const e0 = before.entries.find((e) => e.id === "ollama-x")!;
    expect(e0.profile.enabled).not.toBe(false);

    const patch = await fetch(`${baseUrl}/v1/config/profile/ollama-x`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, scope: "workspace" }),
    });
    expect(patch.status).toBe(200);

    const after = await fetch(`${baseUrl}/v1/models`).then((r) => r.json()) as { entries: Array<{ id: string; profile: { enabled?: boolean } }> };
    const e1 = after.entries.find((e) => e.id === "ollama-x")!;
    expect(e1.profile.enabled).toBe(false);

    // toggle back
    await fetch(`${baseUrl}/v1/config/profile/ollama-x`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, scope: "workspace" }),
    });
    const final = await fetch(`${baseUrl}/v1/models`).then((r) => r.json()) as { entries: Array<{ id: string; profile: { enabled?: boolean } }> };
    const e2 = final.entries.find((e) => e.id === "ollama-x")!;
    expect(e2.profile.enabled).not.toBe(false);
  });
});
