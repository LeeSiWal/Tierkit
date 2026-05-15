import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { showConfig } from "../src/usecases/showConfig.js";

describe("showConfig", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    delete process.env.TIERKIT_TEST_SHOWCONFIG_KEY;
  });

  it("masks API key env vars by default and reports presence", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-showconfig-"));
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          priv: {
            kind: "private-remote",
            provider: "openai-compatible",
            baseUrl: "https://example.com/v1",
            model: "x",
            apiKeyEnv: "TIERKIT_TEST_SHOWCONFIG_KEY",
          },
        },
      }),
    );
    process.env.TIERKIT_TEST_SHOWCONFIG_KEY = "supersecret";
    const r = await showConfig({ cwd: root });
    expect(r.configFound).toBe(true);
    expect(r.apiKeyEnvStatus).toHaveLength(1);
    expect(r.apiKeyEnvStatus[0]?.envVar).toBe("TIERKIT_TEST_SHOWCONFIG_KEY");
    expect(r.apiKeyEnvStatus[0]?.present).toBe(true);
    expect(r.apiKeyEnvStatus[0]?.value).toBeUndefined();
  });

  it("reveals env values only when revealEnvValues=true", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-showconfig-"));
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          priv: {
            kind: "private-remote",
            provider: "openai-compatible",
            baseUrl: "https://example.com/v1",
            model: "x",
            apiKeyEnv: "TIERKIT_TEST_SHOWCONFIG_KEY",
          },
        },
      }),
    );
    process.env.TIERKIT_TEST_SHOWCONFIG_KEY = "supersecret";
    const r = await showConfig({ cwd: root, revealEnvValues: true });
    expect(r.apiKeyEnvStatus[0]?.value).toBe("supersecret");
  });

  it("reports present=false when env var is not set", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-showconfig-"));
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          priv: {
            kind: "private-remote",
            provider: "openai-compatible",
            baseUrl: "https://example.com/v1",
            model: "x",
            apiKeyEnv: "TIERKIT_TEST_SHOWCONFIG_KEY_NOT_SET",
          },
        },
      }),
    );
    const r = await showConfig({ cwd: root });
    expect(r.apiKeyEnvStatus[0]?.present).toBe(false);
  });
});
