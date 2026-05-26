import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";

async function startWith(initial: object) {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-gw-status-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify(initial));
  const srv = await startServer({ port: 0, host: "127.0.0.1", cwd: dir });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

describe("GET /v1/gateway/status", () => {
  it("returns routesEnabled=true when on", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const res = await fetch(`${url}/v1/gateway/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { gatewayMode: string; routesEnabled: boolean; logPath: string; transformations: { mode: string; allowlistedToolCount: number } };
      expect(body.gatewayMode).toBe("on");
      expect(body.routesEnabled).toBe(true);
      expect(path.isAbsolute(body.logPath)).toBe(true);
      expect(body.logPath).toContain(dir);
      expect(body.transformations).toMatchObject({ mode: "off", allowlistedToolCount: 0 });
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("returns routesEnabled=false when off", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/gateway/status`);
      expect(((await res.json()) as { routesEnabled: boolean }).routesEnabled).toBe(false);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
