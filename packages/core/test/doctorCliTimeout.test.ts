import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { doctor } from "../src/usecases/doctor.js";

/**
 * v0.16 Task 6.2 — doctor surfaces a hint when recent cli-timeout entries
 * are found in `.tierkit/runtime/usage.jsonl`.
 *
 * Uses the same disk-seed pattern as doctorBudgetChecks.test.ts and
 * doctorEnvCheck.test.ts. The doctor() function accepts { cwd } not
 * { workspaceRoot }, so we use the real interface.
 */

describe("doctor: cli-timeout hint (v0.16)", () => {
  it("emits a hint when usage.jsonl has recent cli-timeout entries", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-cto-"));
    try {
      await fs.mkdir(path.join(workspace, ".tierkit", "runtime"), { recursive: true });
      const recent = new Date().toISOString();
      const entry =
        JSON.stringify({
          ts: recent,
          type: "mcp-tool",
          tool: "claudeCode",
          ok: false,
          code: "cli-timeout",
        }) + "\n";
      await fs.writeFile(path.join(workspace, ".tierkit", "runtime", "usage.jsonl"), entry);

      const result = await doctor({ cwd: workspace });
      const hint = result.checks.find((c) => c.id === "cli-timeout-hint");
      expect(hint).toBeDefined();
      expect(hint!.status).toBe("warn");
      expect(hint!.detail).toMatch(/cli-timeout/);
      expect(hint!.detail).toMatch(/transport\.timeoutMs/);
      expect(hint!.detail).toMatch(/MODEL_PROFILES\.md/);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("does NOT emit a hint when usage.jsonl has no cli-timeout entries", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-cto-"));
    try {
      await fs.mkdir(path.join(workspace, ".tierkit", "runtime"), { recursive: true });
      const recent = new Date().toISOString();
      const entry =
        JSON.stringify({
          ts: recent,
          type: "mcp-tool",
          tool: "claudeCode",
          ok: true,
          code: "ok",
        }) + "\n";
      await fs.writeFile(path.join(workspace, ".tierkit", "runtime", "usage.jsonl"), entry);

      const result = await doctor({ cwd: workspace });
      const hint = result.checks.find((c) => c.id === "cli-timeout-hint");
      expect(hint).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("does NOT emit a hint when usage.jsonl is absent", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-cto-"));
    try {
      // no usage.jsonl written
      const result = await doctor({ cwd: workspace });
      const hint = result.checks.find((c) => c.id === "cli-timeout-hint");
      expect(hint).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("does NOT emit a hint for cli-timeout entries older than 7 days", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-cto-"));
    try {
      await fs.mkdir(path.join(workspace, ".tierkit", "runtime"), { recursive: true });
      // 8 days ago
      const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
      const entry =
        JSON.stringify({
          ts: old,
          type: "mcp-tool",
          tool: "claudeCode",
          ok: false,
          code: "cli-timeout",
        }) + "\n";
      await fs.writeFile(path.join(workspace, ".tierkit", "runtime", "usage.jsonl"), entry);

      const result = await doctor({ cwd: workspace });
      const hint = result.checks.find((c) => c.id === "cli-timeout-hint");
      expect(hint).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
