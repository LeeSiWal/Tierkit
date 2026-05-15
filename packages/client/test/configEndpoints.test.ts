import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "@tierkit/core";
import { TierkitClient } from "../src/index.js";

describe("config endpoints (add/remove profile + init)", () => {
  let root: string;
  let server: RunningServer;
  let client: TierkitClient;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-config-ep-"));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0 });
    client = new TierkitClient({ baseUrl: `http://127.0.0.1:${server.port}` });
  });

  afterEach(async () => {
    await server.close().catch(() => {});
  });

  it("POST /v1/config/profile writes a workspace profile that shows up in /v1/models", async () => {
    await client.configAddProfile({
      id: "myLocal",
      profile: {
        kind: "local-device",
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        baseUrl: "http://127.0.0.1:11434",
        roles: [],
      },
      scope: "workspace",
    });
    const models = await client.models();
    const ours = models.entries.find((e) => e.id === "myLocal");
    expect(ours).toBeDefined();
    expect(ours?.source).toBe("workspace");
    const written = JSON.parse(await fs.readFile(path.join(root, "tierkit.config.json"), "utf8"));
    expect(written.modelProfiles.myLocal.model).toBe("qwen2.5-coder:7b");
  });

  it("DELETE /v1/config/profile/:id writes an explicit null entry", async () => {
    await client.configAddProfile({
      id: "toDelete",
      profile: { kind: "local-device", provider: "ollama", model: "x", baseUrl: "http://127.0.0.1:11434", roles: [] },
    });
    await client.configRemoveProfile("toDelete");
    const written = JSON.parse(await fs.readFile(path.join(root, "tierkit.config.json"), "utf8"));
    expect(written.modelProfiles.toDelete).toBeNull();
  });

  it("POST /v1/config/init scaffolds tierkit.config.json", async () => {
    const r = await client.configInit();
    expect(r.created.length).toBeGreaterThan(0);
    expect(r.configPath).toContain("tierkit.config.json");
    expect(await fs.access(r.configPath).then(() => true, () => false)).toBe(true);
  });

  it("POST /v1/config/profile returns invalid-id code for malformed profile ids (contract: 400 surfaces as typed body, not exception)", async () => {
    const r = (await client.configAddProfile({
      id: "1invalid",
      profile: { kind: "local-device", provider: "ollama", model: "x", baseUrl: "http://127.0.0.1:11434", roles: [] },
    })) as unknown as { code?: string; message?: string };
    expect(r.code).toBe("invalid-id");
  });
});
