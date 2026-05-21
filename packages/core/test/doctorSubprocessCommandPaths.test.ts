import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { doctor } from "../src/usecases/doctor.js";

/**
 * v0.17 Task 5.2 — doctor emits a `warn` check when any subscription-CLI
 * profile's `transport.command` contains spaces. runChild quotes these for
 * cmd.exe on Windows (Task 5.1), but they can still bite in other shells, so
 * we surface the hint up front.
 */
describe("doctor: subscription CLI command-path space warning (v0.17)", () => {
  it("emits a warn check when a profile's transport.command contains spaces", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-spaces-"));
    try {
      await fs.writeFile(path.join(workspace, "tierkit.config.json"), JSON.stringify({
        version: "0.1",
        modelProfiles: {
          claudeCode: {
            kind: "public-cloud",
            paymentModel: "flat-rate",
            provider: "claude-code",
            model: "auto",
            roles: ["code"],
            requiresApproval: true,
            transport: {
              type: "subprocess",
              command: "C:\\Program Files\\Claude\\claude.exe",
              args: [],
              healthCheckArgs: ["--version"],
              timeoutMs: 300000,
              maxStdoutBytes: 2000000,
              maxStderrBytes: 524288,
            },
          },
        },
      }));
      const result = await doctor({ cwd: workspace });
      const hit = result.checks.find((c) => c.id === "subprocess-command-space-claudeCode");
      expect(hit).toBeDefined();
      expect(hit!.status).toBe("warn");
      expect(hit!.detail).toMatch(/space/i);
      expect(hit!.detail).toMatch(/claude\.exe/);
      expect(hit!.targetProfileId).toBe("claudeCode");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits NO warning when no transport command has spaces", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-nospaces-"));
    try {
      await fs.writeFile(path.join(workspace, "tierkit.config.json"), JSON.stringify({
        version: "0.1",
        modelProfiles: {
          claudeCode: {
            kind: "public-cloud",
            paymentModel: "flat-rate",
            provider: "claude-code",
            model: "auto",
            roles: ["code"],
            requiresApproval: true,
            transport: {
              type: "subprocess",
              command: "claude",
              args: [],
              healthCheckArgs: ["--version"],
              timeoutMs: 300000,
              maxStdoutBytes: 2000000,
              maxStderrBytes: 524288,
            },
          },
        },
      }));
      const result = await doctor({ cwd: workspace });
      const hit = result.checks.find((c) => c.id.startsWith("subprocess-command-space-"));
      expect(hit).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
