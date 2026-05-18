import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeProfile } from "../src/usecases/profileCrud.js";
import { loadConfig } from "../src/config/loadConfig.js";
import * as discoverModule from "../src/model/discoverOllamaProfiles.js";

let tmp: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-del-disc-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.TIERKIT_NO_DISCOVERY;
  delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("delete discovered Ollama profile — end-to-end", () => {
  it("a deleted auto-discovered profile does NOT reappear after refresh", async () => {
    // Mock Ollama discovery to return one fake profile.
    vi.spyOn(discoverModule, "discoverOllamaProfiles").mockResolvedValue({
      "ollama-qwen-test": {
        kind: "local-device",
        provider: "ollama",
        model: "qwen:test",
        baseUrl: "http://127.0.0.1:11434",
        roles: [],
        cost: { type: "free" },
      },
    });

    // 1. Before delete: profile shows up in loadConfig.
    const before = await loadConfig(tmp);
    expect("ollama-qwen-test" in before.config.modelProfiles).toBe(true);
    expect(before.profileSources["ollama-qwen-test"]).toBe("discovered");

    // 2. User clicks delete (writes null to workspace config).
    const r = await removeProfile({ cwd: tmp, id: "ollama-qwen-test", scope: "workspace" });
    expect(r.id).toBe("ollama-qwen-test");

    // 3. Verify the workspace config now has the null suppression.
    const wsRaw = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(wsRaw.modelProfiles["ollama-qwen-test"]).toBe(null);

    // 4. After delete: refreshModels → loadConfig → profile should be gone.
    const after = await loadConfig(tmp);
    expect("ollama-qwen-test" in after.config.modelProfiles).toBe(false);
  });
});
