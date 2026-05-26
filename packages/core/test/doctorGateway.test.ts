import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctorGateway } from "../src/usecases/doctorGateway.js";

async function projectWith(config: object): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-doctor-gw-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify(config));
  return dir;
}

describe("doctorGateway", () => {
  it("flags gatewayMode=off as warn", async () => {
    const dir = await projectWith({ version: "0.1" });
    try {
      const m = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-mode");
      expect(m?.status).toBe("warn");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports daemon unreachable when no daemon is running", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } });
    try {
      const d = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-daemon");
      expect(d?.status).toBe("fail");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports log path writable AND matches resolved dataDir", async () => {
    const dataDir = path.join(await mkdtemp(path.join(tmpdir(), "tk-gw-dd-")), ".tierkit/runtime");
    await mkdir(dataDir, { recursive: true });
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", dataDir } });
    try {
      const log = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-log-path");
      expect(log?.status).toBe("ok");
      expect(log?.detail).toContain(dataDir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("probes loopback URL even when runtime.host is non-loopback (asserts on label)", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", host: "0.0.0.0", port: 1 } });
    try {
      const d = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-daemon");
      // The check's label embeds the URL doctor actually probed.
      expect(d?.label).toContain("http://127.0.0.1:1");
      expect(d?.label).not.toContain("0.0.0.0");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("uses [::1] when host is IPv6", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", host: "::", port: 1 } });
    try {
      const d = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-daemon");
      expect(d?.label).toContain("[::1]:1");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports credential mode without echoing the value", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const cm = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-credential-mode");
      expect(cm?.status).toBe("ok");
      if (process.env.ANTHROPIC_API_KEY) {
        expect(cm?.detail).not.toContain(process.env.ANTHROPIC_API_KEY);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
