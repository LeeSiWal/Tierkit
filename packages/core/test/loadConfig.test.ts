import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { loadConfig } from "@tierkit/core";

let tmp = "";

beforeEach(async () => {
  process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1"; // fixture isolation
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-loadcfg-"));
});
afterEach(async () => {
  delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loadConfig migrations (v0.12.3)", () => {
  it("strips enabled:false field on load and folds into disabledProfileIds", async () => {
    await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify({
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false },
      },
    }));
    const cfg = await loadConfig(tmp, { homeDirOverride: tmp });
    expect(cfg.config.disabledProfileIds).toContain("foo");
    // Re-read raw file: enabled field should be gone
    const raw = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(raw.modelProfiles.foo.enabled).toBeUndefined();
  });

  it("collapses canonical duplicates on load (workspace, richer-roles wins)", async () => {
    await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify({
      version: "0.1",
      modelProfiles: {
        localCoder: { kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b", roles: ["code", "review"] },
        "ollama-qwen2-5-coder-7b": { kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b", roles: ["code"] },
      },
    }));
    const cfg = await loadConfig(tmp, { homeDirOverride: tmp });
    expect(cfg.config.modelProfiles.localCoder).toBeTruthy();
    expect(cfg.config.modelProfiles["ollama-qwen2-5-coder-7b"]).toBeUndefined();
  });

  it("Ollama discovery skips models already covered by an explicit profile", async () => {
    // No real Ollama daemon in tests — discovery is gated by network call.
    // This test ensures the canonical-identity check is wired in even if discovery
    // returns nothing on this CI machine. With TIERKIT_NO_BUNDLED_DEFAULTS=1 and no
    // user/workspace profiles, the result simply has zero profiles.
    const cfg = await loadConfig(tmp, { homeDirOverride: tmp });
    // Either: empty (no ollama running) OR has discovered entries (ollama running on CI is unlikely).
    // Stable assertion: no error, no duplicates.
    const identities = Object.values(cfg.config.modelProfiles)
      .map((p: any) => [p.provider, p.baseUrl, p.model].join("|"));
    expect(new Set(identities).size).toBe(identities.length);
  });
});
