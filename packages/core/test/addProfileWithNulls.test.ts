import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addProfile, removeProfile } from "../src/usecases/profileCrud.js";
import { loadConfig } from "../src/config/loadConfig.js";

let tmp: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-repro-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.TIERKIT_NO_DISCOVERY;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("addProfile preserves null suppression markers", () => {
  it("scenario A: delete then add Gemini — addProfile should succeed", async () => {
    // Step 1: user has had at least one profile + deletes it (writes null to workspace)
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: { "ollama-foo": null },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1", discoverOllamaModels: false },
      }),
    );

    // Step 2: user adds Gemini via the GUI
    const geminiProfile = {
      kind: "public-cloud" as const,
      provider: "openai",
      model: "gemini-2.0-flash",
      apiKeyEnv: "GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      roles: [],
      requiresApproval: true,
      defaultMode: "review-only" as const,
    };
    await addProfile({ cwd: tmp, id: "geminiCustom", profile: geminiProfile, scope: "workspace" });

    // Step 3: verify gemini IS saved and the null suppression survived
    const cfg = await loadConfig(tmp);
    expect(cfg.config.modelProfiles.geminiCustom).toBeDefined();
    expect(cfg.config.modelProfiles.geminiCustom.model).toBe("gemini-2.0-flash");
    expect(cfg.config.modelProfiles["ollama-foo"]).toBeUndefined(); // still suppressed
  });
});
