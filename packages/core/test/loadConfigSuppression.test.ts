import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/loadConfig.js";

describe("loadConfig — suppressed discovered profiles", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-supp-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmp; // isolate from real ~/.tierkit
    // Suppress TIERKIT_NO_DISCOVERY in case test setup set it.
    delete process.env.TIERKIT_NO_DISCOVERY;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("respects null-suppression for an id even when discovery would re-add it", async () => {
    // Write a workspace config that suppresses a hypothetical discovered id.
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: { "ollama-fake-suppressed": null },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1", discoverOllamaModels: false },
      }),
    );
    const r = await loadConfig(tmp);
    expect("ollama-fake-suppressed" in r.config.modelProfiles).toBe(false);
  });
});
