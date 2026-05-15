import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/loadConfig.js";

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-config-layer-"));
  return dir;
}

describe("loadConfig 3-tier merge", () => {
  it("returns ONLY bundled defaults when no workspace or user config exists (includeBundled=true overrides test env)", async () => {
    const ws = await makeTmpDir();
    const userHome = await makeTmpDir();
    const r = await loadConfig(ws, { includeBundled: true, homeDirOverride: userHome });
    const ids = Object.keys(r.config.modelProfiles);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("localCoder");
    expect(ids).toContain("claudeSonnet");
    expect(r.profileSources["localCoder"]).toBe("bundled");
    expect(r.found).toBe(false);
    expect(r.userConfigPath).toBeNull();
  });

  it("workspace profile overrides bundled with the same id, source becomes 'workspace'", async () => {
    const ws = await makeTmpDir();
    const userHome = await makeTmpDir();
    await fs.writeFile(
      path.join(ws, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "custom-override", apiKeyEnv: "X" },
        },
      }),
      "utf8",
    );
    const r = await loadConfig(ws, { includeBundled: true, homeDirOverride: userHome });
    expect(r.config.modelProfiles["claudeSonnet"]?.model).toBe("custom-override");
    expect(r.profileSources["claudeSonnet"]).toBe("workspace");
    expect(r.profileSources["localCoder"]).toBe("bundled");
    expect(r.found).toBe(true);
  });

  it("user-level profile is reached when workspace omits it", async () => {
    const ws = await makeTmpDir();
    const userHome = await makeTmpDir();
    await fs.mkdir(path.join(userHome, ".tierkit"), { recursive: true });
    await fs.writeFile(
      path.join(userHome, ".tierkit", "config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          myUserProfile: { kind: "local-device", provider: "ollama", model: "my-private", baseUrl: "http://127.0.0.1:11434" },
        },
      }),
      "utf8",
    );
    const r = await loadConfig(ws, { includeBundled: true, homeDirOverride: userHome });
    expect(r.config.modelProfiles["myUserProfile"]?.model).toBe("my-private");
    expect(r.profileSources["myUserProfile"]).toBe("user");
    expect(r.userConfigPath).toContain(".tierkit");
  });

  it("workspace overrides user overrides bundled (full 3-tier stack)", async () => {
    const ws = await makeTmpDir();
    const userHome = await makeTmpDir();
    await fs.mkdir(path.join(userHome, ".tierkit"), { recursive: true });
    await fs.writeFile(
      path.join(userHome, ".tierkit", "config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "user-level", apiKeyEnv: "X" },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(ws, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "workspace-level", apiKeyEnv: "X" },
        },
      }),
      "utf8",
    );
    const r = await loadConfig(ws, { includeBundled: true, homeDirOverride: userHome });
    expect(r.config.modelProfiles["claudeSonnet"]?.model).toBe("workspace-level");
    expect(r.profileSources["claudeSonnet"]).toBe("workspace");
  });

  it("setting a profile to null in workspace suppresses the bundled default", async () => {
    const ws = await makeTmpDir();
    const userHome = await makeTmpDir();
    await fs.writeFile(
      path.join(ws, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: { claudeSonnet: null, gpt4o: null },
      }),
      "utf8",
    );
    const r = await loadConfig(ws, { includeBundled: true, homeDirOverride: userHome });
    expect(r.config.modelProfiles["claudeSonnet"]).toBeUndefined();
    expect(r.config.modelProfiles["gpt4o"]).toBeUndefined();
    expect(r.config.modelProfiles["localCoder"]).toBeDefined(); // not nulled
  });

  it("includeBundled=false yields a clean slate (used by tests)", async () => {
    const ws = await makeTmpDir();
    const userHome = await makeTmpDir();
    const r = await loadConfig(ws, { includeBundled: false, homeDirOverride: userHome });
    expect(Object.keys(r.config.modelProfiles)).toHaveLength(0);
  });
});
