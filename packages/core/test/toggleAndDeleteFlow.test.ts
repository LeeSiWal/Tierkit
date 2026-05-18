/**
 * Real user-workflow tests for the toggle ON/OFF + delete buttons in the GUI.
 *
 * These mock the Ollama discovery probe (so the test doesn't depend on a running daemon)
 * but otherwise exercise the actual loadConfig + profileCrud + listModels stack used by
 * the GUI when the user clicks the buttons.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeProfile, updateProfileEnabled } from "../src/usecases/profileCrud.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { listModels } from "../src/usecases/listModels.js";
import * as discoverModule from "../src/model/discoverOllamaProfiles.js";

let tmp: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-flow-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  delete process.env.TIERKIT_NO_DISCOVERY;
  delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
  // Two fake Ollama models (simulates `ollama list`).
  vi.spyOn(discoverModule, "discoverOllamaProfiles").mockResolvedValue({
    "ollama-qwen-test": {
      kind: "local-device", provider: "ollama", model: "qwen:test",
      baseUrl: "http://127.0.0.1:11434", roles: [], cost: { type: "free" },
    },
    "ollama-llama-test": {
      kind: "local-device", provider: "ollama", model: "llama:test",
      baseUrl: "http://127.0.0.1:11434", roles: [], cost: { type: "free" },
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("ON/OFF toggle — discovered profile", () => {
  it("toggling OFF marks the profile enabled:false in the next listModels", async () => {
    // Sanity: both profiles are present and ON by default.
    let r = await listModels({ cwd: tmp });
    const before = r.entries.find((e) => e.id === "ollama-qwen-test")!;
    expect(before).toBeDefined();
    expect(before.profile.enabled).not.toBe(false); // undefined or true

    // User clicks the ON button → handler sends enabled: false.
    await updateProfileEnabled({ cwd: tmp, id: "ollama-qwen-test", scope: "workspace", enabled: false });

    // Refresh: same id, now enabled:false.
    r = await listModels({ cwd: tmp });
    const after = r.entries.find((e) => e.id === "ollama-qwen-test")!;
    expect(after).toBeDefined();
    expect(after.profile.enabled).toBe(false);

    // Other profile is unaffected.
    const other = r.entries.find((e) => e.id === "ollama-llama-test")!;
    expect(other.profile.enabled).not.toBe(false);
  });

  it("toggling OFF then ON returns to enabled state", async () => {
    await updateProfileEnabled({ cwd: tmp, id: "ollama-qwen-test", scope: "workspace", enabled: false });
    await updateProfileEnabled({ cwd: tmp, id: "ollama-qwen-test", scope: "workspace", enabled: true });
    const r = await listModels({ cwd: tmp });
    const e = r.entries.find((x) => x.id === "ollama-qwen-test")!;
    expect(e.profile.enabled).not.toBe(false);
    // disabledProfileIds should not contain the id any more.
    const ws = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(ws.disabledProfileIds ?? []).not.toContain("ollama-qwen-test");
  });
});

describe("Delete — discovered profile", () => {
  it("deleting an auto-discovered profile removes it from the next listModels", async () => {
    let r = await listModels({ cwd: tmp });
    expect(r.entries.some((e) => e.id === "ollama-qwen-test")).toBe(true);

    await removeProfile({ cwd: tmp, id: "ollama-qwen-test", scope: "workspace" });

    r = await listModels({ cwd: tmp });
    expect(r.entries.some((e) => e.id === "ollama-qwen-test")).toBe(false);
    // The other discovered profile is still there.
    expect(r.entries.some((e) => e.id === "ollama-llama-test")).toBe(true);
  });
});

describe("Mixed: delete + toggle", () => {
  it("deleting one profile + disabling another both stick across reloads", async () => {
    await removeProfile({ cwd: tmp, id: "ollama-qwen-test", scope: "workspace" });
    await updateProfileEnabled({ cwd: tmp, id: "ollama-llama-test", scope: "workspace", enabled: false });

    const r = await listModels({ cwd: tmp });
    expect(r.entries.some((e) => e.id === "ollama-qwen-test")).toBe(false);
    const llama = r.entries.find((e) => e.id === "ollama-llama-test");
    expect(llama).toBeDefined();
    expect(llama!.profile.enabled).toBe(false);
  });
});
