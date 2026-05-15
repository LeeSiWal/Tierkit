import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRoute } from "../src/usecases/runRoute.js";
import { MockModelClient } from "../src/model/providers/mock.js";
import { startSession, advanceSession, approvePlan } from "../src/usecases/session.js";

interface SetupOpts {
  freedom: "free" | "guided" | "balanced" | "strict";
}

async function setup(opts: SetupOpts): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-runroute-gate-"));
  await fs.mkdir(path.join(root, ".tierkit", "plugins", "strictplugin"), { recursive: true });
  const manifest = {
    schemaVersion: "0.1",
    id: "strictplugin",
    name: "Strictplugin",
    version: "0.1.0",
    description: "x",
    author: "t",
    license: "MIT",
    compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
    components: { commands: [], modes: [], rules: [], workflows: [], hooks: [] },
    permissions: { readFiles: true },
    freedom: { level: opts.freedom },
  };
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins", "strictplugin", "tierkit.plugin.json"),
    JSON.stringify(manifest),
  );
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({
      version: "0.1",
      plugins: [
        {
          id: "strictplugin",
          version: "0.1.0",
          installedAt: new Date().toISOString(),
          pluginDir: path.join(root, ".tierkit", "plugins", "strictplugin"),
          manifest,
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(root, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      activePlugins: ["strictplugin"],
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "x", baseUrl: "http://example" },
      },
    }),
  );
  return root;
}

describe("runRoute workflow gate", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("free plugin: no gating, route run proceeds", async () => {
    root = await setup({ freedom: "free" });
    const r = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      clientFactory: () => new MockModelClient({ chunks: ["ok"] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) for await (const _ of r.stream) {/* drain */}
  });

  it("strict plugin + no session: refuses execute with code=no-session", async () => {
    root = await setup({ freedom: "strict" });
    const r = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      clientFactory: () => new MockModelClient({ chunks: ["ok"] }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no-session");
  });

  it("strict plugin + planning session + planApproved=false: refuses execute with plan-not-approved", async () => {
    root = await setup({ freedom: "strict" });
    await startSession({ cwd: root, task: "x" });
    const r = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      clientFactory: () => new MockModelClient({ chunks: ["ok"] }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("plan-not-approved");
  });

  it("strict plugin + plan approved + state=implementing: execute allowed", async () => {
    root = await setup({ freedom: "strict" });
    await startSession({ cwd: root, task: "x" });
    await approvePlan({ cwd: root });
    await advanceSession({ cwd: root, toState: "implementing" });
    const r = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      clientFactory: () => new MockModelClient({ chunks: ["ok"] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) for await (const _ of r.stream) {/* drain */}
  });

  it("balanced plugin + multi-file (files=5) + no session: refuses", async () => {
    root = await setup({ freedom: "balanced" });
    const r = await runRoute({
      cwd: root,
      env: {},
      task: "rewrite many",
      filesTouchedEstimate: 5,
      clientFactory: () => new MockModelClient({ chunks: ["ok"] }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no-session");
  });

  it("balanced plugin + single-file: allowed without a session", async () => {
    root = await setup({ freedom: "balanced" });
    const r = await runRoute({
      cwd: root,
      env: {},
      task: "rename helper",
      filesTouchedEstimate: 1,
      clientFactory: () => new MockModelClient({ chunks: ["ok"] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) for await (const _ of r.stream) {/* drain */}
  });

  it("guided plugin: never blocks; attaches a workflowWarning when no session", async () => {
    root = await setup({ freedom: "guided" });
    const r = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      clientFactory: () => new MockModelClient({ chunks: ["ok"] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.workflowWarning).toBeDefined();
      for await (const _ of r.stream) {/* drain */}
    }
  });
});
