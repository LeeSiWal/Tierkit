import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateProfileEnabled } from "../src/usecases/profileCrud.js";
import { loadConfig } from "../src/config/loadConfig.js";

describe("profile enabled toggle", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-enabled-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmp;
    delete process.env.TIERKIT_NO_DISCOVERY;
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          localFast: { kind: "local-device", provider: "mock", model: "tiny", roles: [] },
        },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1", discoverOllamaModels: false },
      }),
    );
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("disabling a profile sets enabled=false in the loaded config", async () => {
    await updateProfileEnabled({ cwd: tmp, id: "localFast", scope: "workspace", enabled: false });
    const cfg = await loadConfig(tmp);
    expect(cfg.config.modelProfiles.localFast.enabled).toBe(false);
  });

  it("re-enabling removes the id from disabledProfileIds", async () => {
    await updateProfileEnabled({ cwd: tmp, id: "localFast", scope: "workspace", enabled: false });
    await updateProfileEnabled({ cwd: tmp, id: "localFast", scope: "workspace", enabled: true });
    const cfg = await loadConfig(tmp);
    expect(cfg.config.modelProfiles.localFast.enabled).not.toBe(false);
    expect(cfg.config.disabledProfileIds).not.toContain("localFast");
  });
});
