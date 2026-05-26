import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";

async function startWith(initial: object) {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-patch-runtime-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify(initial));
  const srv = await startServer({ port: 0, host: "127.0.0.1", cwd: dir });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

describe("PATCH /v1/config/runtime", () => {
  it("flips gatewayMode and persists", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ gatewayMode: "on" }) });
      expect(res.status).toBe(200);
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.gatewayMode).toBe("on");
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects unknown fields", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ port: 9999 }) });
      expect(res.status).toBe(400);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects invalid gatewayMode values", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ gatewayMode: "auto" }) });
      expect(res.status).toBe(400);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("patches valid gatewayTransformations and rejects invalid values", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const ok = await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gatewayTransformations: {
            mode: "observe",
            toolResultEnvelope: { allowlistedToolNames: [], minInputUtf8Bytes: 100 },
          },
        }),
      });
      expect(ok.status).toBe(200);
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.gatewayTransformations.mode).toBe("observe");

      const bad = await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayTransformations: { mode: "envelope", toolResultEnvelope: { minInputUtf8Bytes: -1 } } }),
      });
      expect(bad.status).toBe(400);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("patches measuredCompact and rejects unsafe opt-in/conflict", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const ok = await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          measuredCompact: {
            mode: "measured_compact",
            eligibleSources: { tierkitMcpCompactTools: ["tierkit.get_file_digest"] },
            officialTokenMeasurement: { mode: "anthropic_count_tokens_opt_in", consentAcknowledged: true },
          },
        }),
      });
      expect(ok.status).toBe(200);
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.measuredCompact.mode).toBe("measured_compact");

      const noConsent = await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          measuredCompact: {
            mode: "measured_compact",
            officialTokenMeasurement: { mode: "anthropic_count_tokens_opt_in", consentAcknowledged: false },
          },
        }),
      });
      expect(noConsent.status).toBe(400);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("preserves other valid runtime fields", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1", runtime: { port: 4101, dataDir: ".custom/dd", host: "127.0.0.1" } });
    try {
      await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ gatewayMode: "on" }) });
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.dataDir).toBe(".custom/dd");
      expect(disk.runtime.port).toBe(4101);
      expect(disk.runtime.gatewayMode).toBe("on");
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
