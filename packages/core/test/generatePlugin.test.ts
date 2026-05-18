import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePlugin, PluginGenerateError } from "../src/usecases/generatePlugin.js";
import { GENERATE_PLUGIN_EXAMPLE_JSON } from "../src/usecases/generatePluginExample.js";
import * as llmCallModule from "../src/runtime/proxy/llmCall.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-genplugin-"));
  await fs.mkdir(path.join(tmp, ".tierkit"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("generatePlugin — happy path", () => {
  it("returns parsed manifest+rules and writes draft files when LLM returns valid JSON", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true,
      text: GENERATE_PLUGIN_EXAMPLE_JSON,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0,
      latencyMs: 1234,
      profileId: "claudeHaiku",
      model: "claude-haiku-4-5-20251001",
      redactionHits: [],
      commandClassifications: [],
      budget: { status: "ok" },
    });

    const r = await generatePlugin({
      description: "TDD-first Python plugin",
      cwd: tmp,
      env: {},
    });

    expect(r.manifest.id).toBe("tdd-first-python");
    expect(r.rules.length).toBe(3);
    expect(r.modelUsed).toBe("claudeHaiku");
    expect(r.draftId).toMatch(/^[0-9a-f-]{36}$/);

    const manifestExists = await fs.access(path.join(r.draftPath, "tierkit.plugin.json")).then(() => true).catch(() => false);
    expect(manifestExists).toBe(true);
    for (const rule of r.rules) {
      const ruleExists = await fs.access(path.join(r.draftPath, "rules", rule.filename)).then(() => true).catch(() => false);
      expect(ruleExists).toBe(true);
    }
  });

  it("strips markdown code fences around the JSON before parsing", async () => {
    const wrapped = "```json\n" + GENERATE_PLUGIN_EXAMPLE_JSON + "\n```";
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true, text: wrapped,
      inputTokens: 100, outputTokens: 200, costUsd: 0, latencyMs: 1, profileId: "x", model: "x",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const r = await generatePlugin({ description: "x", cwd: tmp, env: {} });
    expect(r.manifest.id).toBe("tdd-first-python");
  });

  it("rejects descriptions longer than 4000 chars", async () => {
    await expect(
      generatePlugin({ description: "x".repeat(4001), cwd: tmp, env: {} }),
    ).rejects.toBeInstanceOf(PluginGenerateError);
  });

  it("rejects empty description", async () => {
    await expect(
      generatePlugin({ description: "", cwd: tmp, env: {} }),
    ).rejects.toBeInstanceOf(PluginGenerateError);
  });
});

describe("generatePlugin — retry", () => {
  it("retries once when the first response is unparseable JSON", async () => {
    const spy = vi.spyOn(llmCallModule, "executeLlmCall");
    spy
      .mockResolvedValueOnce({ ok: true, text: "not valid json {{{", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } })
      .mockResolvedValueOnce({ ok: true, text: GENERATE_PLUGIN_EXAMPLE_JSON, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } });
    const r = await generatePlugin({ description: "x", cwd: tmp, env: {} });
    expect(r.manifest.id).toBe("tdd-first-python");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retries once when schema validation fails", async () => {
    const badManifest = JSON.stringify({ manifest: { id: "missing-required-fields" }, rules: [] });
    const spy = vi.spyOn(llmCallModule, "executeLlmCall");
    spy
      .mockResolvedValueOnce({ ok: true, text: badManifest, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } })
      .mockResolvedValueOnce({ ok: true, text: GENERATE_PLUGIN_EXAMPLE_JSON, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } });
    const r = await generatePlugin({ description: "x", cwd: tmp, env: {} });
    expect(r.manifest.id).toBe("tdd-first-python");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns validation-failed with rawOutput when both attempts fail", async () => {
    const badText = "still not json {{";
    const spy = vi.spyOn(llmCallModule, "executeLlmCall");
    spy.mockResolvedValue({ ok: true, text: badText, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } });
    try {
      await generatePlugin({ description: "x", cwd: tmp, env: {} });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PluginGenerateError);
      const err = e as PluginGenerateError;
      expect(err.code).toBe("validation-failed");
      expect(err.rawOutput).toBe(badText);
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
