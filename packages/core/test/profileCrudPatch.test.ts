import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmp = "";
let server: RunningServer | undefined;
let baseUrl = "";

beforeEach(async () => {
  process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-profile-patch-"));
  await fs.mkdir(path.join(tmp, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        myLocal: {
          kind: "local-device",
          provider: "ollama",
          model: "qwen2.5-coder:7b",
          baseUrl: "http://127.0.0.1:11434",
          roles: ["code"],
        },
      },
    }),
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  baseUrl = `http://${server.address}:${server.port}`;
});

afterEach(async () => {
  delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("PATCH /v1/config/profile/:id — fields patch (roles, goodAt, notGoodAt)", () => {
  it("updates notGoodAt on a workspace profile", async () => {
    const r = await fetch(`${baseUrl}/v1/config/profile/myLocal`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notGoodAt: ["code-review"], scope: "workspace" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string };
    expect(body.id).toBe("myLocal");

    // Verify the field was written to disk
    const raw = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(raw.modelProfiles.myLocal.notGoodAt).toEqual(["code-review"]);
  });

  it("updates roles on a workspace profile", async () => {
    const r = await fetch(`${baseUrl}/v1/config/profile/myLocal`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles: ["code", "review"], scope: "workspace" }),
    });
    expect(r.status).toBe(200);

    const raw = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(raw.modelProfiles.myLocal.roles).toEqual(["code", "review"]);
  });

  it("updates goodAt on a workspace profile", async () => {
    const r = await fetch(`${baseUrl}/v1/config/profile/myLocal`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goodAt: ["summarize", "translate"], scope: "workspace" }),
    });
    expect(r.status).toBe(200);

    const raw = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(raw.modelProfiles.myLocal.goodAt).toEqual(["summarize", "translate"]);
  });

  it("still handles enabled toggle on PATCH", async () => {
    // The enabled=false toggle should still work through PATCH
    const r = await fetch(`${baseUrl}/v1/config/profile/myLocal`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, scope: "workspace" }),
    });
    expect(r.status).toBe(200);

    const raw = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(raw.disabledProfileIds).toContain("myLocal");
  });

  it("returns 400 when body has neither enabled nor patch fields", async () => {
    const r = await fetch(`${baseUrl}/v1/config/profile/myLocal`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "workspace" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("DELETE /v1/config/profile/:id?scope=workspace — workspace override removal", () => {
  it("removes a workspace profile and it disappears from GET /v1/config", async () => {
    const r = await fetch(`${baseUrl}/v1/config/profile/myLocal?scope=workspace`, {
      method: "DELETE",
    });
    expect(r.status).toBe(200);

    const cfgR = await fetch(`${baseUrl}/v1/config`);
    const cfg = (await cfgR.json()) as { config: { modelProfiles: Record<string, unknown> } };
    expect(cfg.config.modelProfiles["myLocal"]).toBeUndefined();
  });
});
