import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { doctor } from "../src/usecases/doctor.js";

async function makeProject(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-env-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

describe("doctor: api key env vars", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    delete process.env.TIERKIT_DOCTOR_TEST_KEY;
  });

  it("warns when a declared apiKeyEnv is not set", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: {
        priv: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "m",
          apiKeyEnv: "TIERKIT_DOCTOR_TEST_KEY_MISSING",
        },
      },
    });
    const r = await doctor({ cwd: root });
    const check = r.checks.find((c) => c.id === "api-key-env");
    expect(check).toBeDefined();
    expect(check!.status).toBe("warn");
    expect(check!.detail).toContain("TIERKIT_DOCTOR_TEST_KEY_MISSING");
  });

  it("ok when all declared apiKeyEnv values are present", async () => {
    process.env.TIERKIT_DOCTOR_TEST_KEY = "present";
    root = await makeProject({
      version: "0.1",
      modelProfiles: {
        priv: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "m",
          apiKeyEnv: "TIERKIT_DOCTOR_TEST_KEY",
        },
      },
    });
    const r = await doctor({ cwd: root });
    const check = r.checks.find((c) => c.id === "api-key-env");
    expect(check!.status).toBe("ok");
  });

  it("ok when no profile declares apiKeyEnv", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: {
        local: { kind: "local-device", provider: "ollama", model: "x" },
      },
    });
    const r = await doctor({ cwd: root });
    expect(r.checks.find((c) => c.id === "api-key-env")?.status).toBe("ok");
  });
});
