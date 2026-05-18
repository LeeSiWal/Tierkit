/**
 * Verifies POST /v1/config/preset applies named presets to the workspace config:
 * routingPolicy.riskThresholds + autoEscalationCeiling get updated, existing
 * profiles whose model name matches the preset's goodAtByModelPattern get tagged.
 * Also covers PATCH /v1/config/routing extended with riskThresholds.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmp: string;
let server: RunningServer | undefined;
let originalHome: string | undefined;

async function boot(initialConfig: Record<string, unknown>) {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-preset-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify(initialConfig));
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  return `http://${server.address}:${server.port}`;
}

afterEach(async () => {
  if (server) { await server.close(); server = undefined; }
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("GET /v1/config/presets", () => {
  it("lists the available presets with descriptions", async () => {
    const baseUrl = await boot({ version: "0.1" });
    const r = await fetch(`${baseUrl}/v1/config/presets`);
    expect(r.status).toBe(200);
    const body = await r.json() as { presets: Array<{ name: string; description: string }> };
    const names = body.presets.map((p) => p.name);
    expect(names).toContain("local-coder-first");
    expect(names).toContain("private-only");
    expect(names).toContain("tierkit-default");
    for (const p of body.presets) expect(p.description.length).toBeGreaterThan(0);
  });
});

describe("POST /v1/config/preset", () => {
  it("local-coder-first lifts localStrongMax + tags coder models with goodAt", async () => {
    const baseUrl = await boot({
      version: "0.1",
      modelProfiles: {
        qwen3: { kind: "local-device", provider: "ollama", model: "qwen3-coder:30b-a3b", roles: [] },
        llama: { kind: "local-device", provider: "ollama", model: "llama3:8b", roles: [] },
      },
    });
    const r = await fetch(`${baseUrl}/v1/config/preset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "local-coder-first" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; changes: { profilesUpdated?: string[] } };
    expect(body.ok).toBe(true);
    expect(body.changes.profilesUpdated).toContain("qwen3");          // coder pattern matches goodAt rule
    expect(body.changes.profilesUpdated).toContain("llama");          // mid-size general → notGoodAt: [code-review]

    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8")) as Record<string, any>;
    expect(written.routingPolicy.riskThresholds.localStrongMax).toBe(65);
    expect(written.routingPolicy.autoEscalationCeiling).toBe("public-cloud");
    // Strong coder (30B) → all code-* + plan in goodAt.
    expect(written.modelProfiles.qwen3.goodAt).toEqual(["code-generation", "refactor", "code-review", "plan"]);
    // Mid-size general (llama3:8b) → no goodAt (neutral), but notGoodAt excludes code-review.
    expect(written.modelProfiles.llama.goodAt).toBeUndefined();
    expect(written.modelProfiles.llama.notGoodAt).toEqual(["code-review"]);
  });

  it("private-only sets ceiling to private-remote + lifts thresholds for local", async () => {
    const baseUrl = await boot({ version: "0.1" });
    await fetch(`${baseUrl}/v1/config/preset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "private-only" }),
    });
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8")) as Record<string, any>;
    expect(written.routingPolicy.autoEscalationCeiling).toBe("private-remote");
    expect(written.routingPolicy.riskThresholds.privateRemoteMax).toBe(100);
  });

  it("tierkit-default restores stock thresholds", async () => {
    const baseUrl = await boot({
      version: "0.1",
      routingPolicy: { riskThresholds: { localFastMax: 99, localStrongMax: 99, privateRemoteMax: 99, publicCloudReviewMin: 100 } },
    });
    await fetch(`${baseUrl}/v1/config/preset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tierkit-default" }),
    });
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8")) as Record<string, any>;
    expect(written.routingPolicy.riskThresholds.localFastMax).toBe(25);
    expect(written.routingPolicy.riskThresholds.localStrongMax).toBe(50);
  });

  it("returns 400 for unknown preset name", async () => {
    const baseUrl = await boot({ version: "0.1" });
    const r = await fetch(`${baseUrl}/v1/config/preset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "made-up" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unknown-preset");
  });

  it("preserves null-suppression markers from prior deletes", async () => {
    const baseUrl = await boot({
      version: "0.1",
      modelProfiles: { "ollama-foo": null, qwen3: { kind: "local-device", provider: "ollama", model: "qwen3-coder:30b", roles: [] } },
    });
    await fetch(`${baseUrl}/v1/config/preset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "local-coder-first" }),
    });
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8")) as Record<string, any>;
    expect(written.modelProfiles["ollama-foo"]).toBeNull(); // suppression preserved
    expect(written.modelProfiles.qwen3.goodAt).toBeDefined();
  });
});

describe("PATCH /v1/config/routing with riskThresholds", () => {
  it("merges partial riskThresholds (doesn't drop unspecified fields)", async () => {
    const baseUrl = await boot({
      version: "0.1",
      routingPolicy: { riskThresholds: { localFastMax: 25, localStrongMax: 50, privateRemoteMax: 75, publicCloudReviewMin: 76 } },
    });
    const r = await fetch(`${baseUrl}/v1/config/routing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ riskThresholds: { localStrongMax: 65 } }),
    });
    expect(r.status).toBe(200);
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8")) as Record<string, any>;
    expect(written.routingPolicy.riskThresholds.localFastMax).toBe(25);       // preserved
    expect(written.routingPolicy.riskThresholds.localStrongMax).toBe(65);     // updated
    expect(written.routingPolicy.riskThresholds.privateRemoteMax).toBe(75);   // preserved
    expect(written.routingPolicy.riskThresholds.publicCloudReviewMin).toBe(76);
  });

  it("rejects out-of-range or non-integer threshold values", async () => {
    const baseUrl = await boot({ version: "0.1" });
    for (const v of [-1, 101, 50.5, "abc", true]) {
      const r = await fetch(`${baseUrl}/v1/config/routing`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ riskThresholds: { localStrongMax: v } }),
      });
      expect(r.status).toBe(400);
    }
  });
});
