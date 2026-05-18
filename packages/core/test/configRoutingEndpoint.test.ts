import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmp: string;
let server: RunningServer | undefined;

async function boot() {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-routingep-"));
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {},
      routingPolicy: { autoEscalationCeiling: "public-cloud", budgetAwareDowngrade: true, responseQualityCheck: true },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  return `http://${server.address}:${server.port}`;
}

afterEach(async () => {
  if (server) { await server.close(); server = undefined; }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("PATCH /v1/config/routing", () => {
  it("updates autoEscalationCeiling", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/config/routing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoEscalationCeiling: "private-remote" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(written.routingPolicy.autoEscalationCeiling).toBe("private-remote");
  });

  it("rejects unknown ceiling values with 400", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/config/routing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoEscalationCeiling: "moon" }),
    });
    expect(r.status).toBe(400);
  });

  it("ignores unknown fields silently", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/config/routing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unknownField: true, budgetAwareDowngrade: false }),
    });
    expect(r.status).toBe(200);
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(written.routingPolicy.budgetAwareDowngrade).toBe(false);
    expect(written.unknownField).toBeUndefined();
  });
});
