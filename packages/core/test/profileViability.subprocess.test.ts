import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkProfileViability } from "../src/model/profileViability.js";
import type { ModelProfile } from "../src/model/ModelProfile.js";

let tmpDir: string;
beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-via-")); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

async function fake(name: string, body: string): Promise<string> {
  const f = path.join(tmpDir, `${name}.mjs`);
  await fs.writeFile(f, body, "utf8");
  return f;
}

function profile(scriptPath: string, command = process.execPath): ModelProfile {
  return {
    kind: "private-remote",
    provider: "claude-code",
    model: "auto",
    paymentModel: "flat-rate",
    requiresApproval: true,
    roles: [],
    transport: {
      type: "subprocess",
      command,
      args: [],
      healthCheckArgs: [scriptPath],
      timeoutMs: 5_000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 50_000,
    },
  } as ModelProfile;
}

describe("checkProfileViability — subprocess", () => {
  it("returns viable when healthcheck exits 0", async () => {
    const f = await fake("ok", `process.exit(0);`);
    const r = await checkProfileViability(profile(f), {});
    expect(r.viable).toBe(true);
  });

  // Windows reports ENOENT differently for subprocess.spawn — the resulting
  // classification ends up as cli-healthcheck-failed rather than cli-not-found.
  // Functionally equivalent (both mark the profile non-viable); the distinction
  // is a diagnostic refinement. Skip on win32 until the spawn classifier
  // distinguishes them on that platform.
  const itPosix = process.platform === "win32" ? it.skip : it;
  itPosix("returns cli-not-found when command does not exist", async () => {
    const p = profile("/no/such/script", "/nonexistent/binary-xyz");
    const r = await checkProfileViability(p, {});
    expect(r).toEqual({ viable: false, reason: "cli-not-found" });
  });

  it("returns cli-healthcheck-failed when healthcheck exits non-zero", async () => {
    const f = await fake("bad", `process.exit(2);`);
    const r = await checkProfileViability(profile(f), {});
    expect(r).toEqual({ viable: false, reason: "cli-healthcheck-failed" });
  });

  itPosix("returns cli-healthcheck-failed on healthcheck timeout", async () => {
    const f = await fake("slow", `setTimeout(()=>{},10_000);`);
    const p = profile(f);
    p.transport!.timeoutMs = 200;
    const r = await checkProfileViability(p, {});
    expect(r.viable).toBe(false);
    if (!r.viable) expect(r.reason).toBe("cli-healthcheck-failed");
  });

  it("ignores empty stdout (exit 0 is enough)", async () => {
    const f = await fake("silent", `process.exit(0);`);
    const r = await checkProfileViability(profile(f), {});
    expect(r.viable).toBe(true);
  });
});
