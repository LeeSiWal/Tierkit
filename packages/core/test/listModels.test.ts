import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listModels } from "../src/usecases/listModels.js";

async function makeProjectWithConfig(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-listmodels-"));
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

describe("listModels", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the list of profiles from tierkit.config.json", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      defaultTarget: "generic",
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b" },
        privateRemoteStrong: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "qwen-coder-72b",
          apiKeyEnv: "TIERKIT_PRIVATE_LLM_KEY",
        },
      },
    });
    const r = await listModels({ cwd: root });
    expect(r.configFound).toBe(true);
    expect(r.entries.map((e) => e.id).sort()).toEqual(["localFast", "privateRemoteStrong"]);
  });

  it("returns empty entries when no config exists", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-listmodels-empty-"));
    const r = await listModels({ cwd: root });
    expect(r.configFound).toBe(false);
    expect(r.entries).toEqual([]);
  });
});
