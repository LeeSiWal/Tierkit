import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { startServer, type RunningServer } from "@tierkit/core";

let tmp = "";
let server: RunningServer | null = null;
let baseUrl = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-profile-http-"));
  process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
  await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify({
    version: "0.1",
    modelProfiles: {
      manualProfile: { kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "x", roles: [] },
    },
  }));
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  baseUrl = `http://${server.address}:${server.port}`;
});
afterEach(async () => {
  delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
  await server?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("DELETE /v1/config/profile/:id guard", () => {
  it("deletes a manually-added workspace profile (suppression marker written)", async () => {
    const res = await fetch(`${baseUrl}/v1/config/profile/manualProfile?scope=workspace`, { method: "DELETE" });
    expect(res.status).toBe(200);
    // After delete, the profile should not appear in GET /v1/config
    const cfgRes = await fetch(`${baseUrl}/v1/config`);
    const cfgBody = await cfgRes.json();
    expect(cfgBody.config.modelProfiles.manualProfile).toBeUndefined();
  });

  it("rejects delete for a bundled-sample profile with 400 cannot-delete-non-editable", async () => {
    // Temporarily remove the env suppression so a bundled sample exists.
    delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
    await server?.close();
    server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
    baseUrl = `http://${server.address}:${server.port}`;

    // localCoder is a bundled sample; try to delete it from workspace scope
    const res = await fetch(`${baseUrl}/v1/config/profile/localCoder?scope=workspace`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("cannot-delete-non-editable");
    expect(body.message).toContain("source: bundled");

    process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
  });
});
