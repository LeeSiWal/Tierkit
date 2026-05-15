import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectTool, detectConnectedTools, pluginNew, PluginNewError } from "../src/index.js";

async function makeTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-connect-sync-"));
}

describe("connectTool", () => {
  it("connect roo writes .vscode/settings.json with the openai-compatible provider keys", async () => {
    const cwd = await makeTmpDir();
    const r = await connectTool({ cwd, tool: "roo", defaultProfile: "claudeSonnet" });
    const settings = JSON.parse(await fs.readFile(r.configPath, "utf8"));
    expect(settings["roo-cline.apiProvider"]).toBe("openai");
    expect(settings["roo-cline.openAiBaseUrl"]).toBe("http://127.0.0.1:4101/v1/openai");
    expect(settings["roo-cline.openAiModelId"]).toBe("claudeSonnet");
  });

  it("connect cline writes the cline.* keys", async () => {
    const cwd = await makeTmpDir();
    const r = await connectTool({ cwd, tool: "cline" });
    const settings = JSON.parse(await fs.readFile(r.configPath, "utf8"));
    expect(settings["cline.apiProvider"]).toBe("openai");
    expect(settings["cline.openAiBaseUrl"]).toBe("http://127.0.0.1:4101/v1/openai");
    expect(settings["cline.openAiModelId"]).toBe("auto");
  });

  it("connect continue creates .continue/config.yaml with a tierkit-routed model entry", async () => {
    const cwd = await makeTmpDir();
    const r = await connectTool({ cwd, tool: "continue", defaultProfile: "localCoder" });
    const yaml = await fs.readFile(r.configPath, "utf8");
    expect(yaml).toContain("tierkit-routed-model");
    expect(yaml).toContain("apiBase: http://127.0.0.1:4101/v1/openai");
    expect(yaml).toContain("model: localCoder");
  });

  it("connect continue is idempotent — running twice does not duplicate the entry", async () => {
    const cwd = await makeTmpDir();
    await connectTool({ cwd, tool: "continue" });
    const r2 = await connectTool({ cwd, tool: "continue" });
    const yaml = await fs.readFile(r2.configPath, "utf8");
    const occurrences = yaml.split("tierkit-routed-model").length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves other entries in existing .vscode/settings.json", async () => {
    const cwd = await makeTmpDir();
    await fs.mkdir(path.join(cwd, ".vscode"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".vscode", "settings.json"),
      JSON.stringify({ "editor.fontSize": 14, "files.autoSave": "onFocusChange" }, null, 2),
    );
    const r = await connectTool({ cwd, tool: "roo" });
    const settings = JSON.parse(await fs.readFile(r.configPath, "utf8"));
    expect(settings["editor.fontSize"]).toBe(14);
    expect(settings["files.autoSave"]).toBe("onFocusChange");
    expect(settings["roo-cline.apiProvider"]).toBe("openai");
  });
});

describe("detectConnectedTools", () => {
  it("returns empty when no tool dirs exist", async () => {
    const cwd = await makeTmpDir();
    const r = await detectConnectedTools(cwd);
    expect(r).toEqual([]);
  });

  it("detects roo when .roomodes exists", async () => {
    const cwd = await makeTmpDir();
    await fs.writeFile(path.join(cwd, ".roomodes"), "");
    const r = await detectConnectedTools(cwd);
    expect(r).toContain("roo");
  });

  it("detects cline when .clinerules/ exists", async () => {
    const cwd = await makeTmpDir();
    await fs.mkdir(path.join(cwd, ".clinerules"), { recursive: true });
    const r = await detectConnectedTools(cwd);
    expect(r).toContain("cline");
  });

  it("detects continue when .continue/ exists", async () => {
    const cwd = await makeTmpDir();
    await fs.mkdir(path.join(cwd, ".continue"), { recursive: true });
    const r = await detectConnectedTools(cwd);
    expect(r).toContain("continue");
  });
});

describe("pluginNew", () => {
  it("creates a loadable plugin skeleton with manifest + one command/mode/rule", async () => {
    const cwd = await makeTmpDir();
    const r = await pluginNew({ cwd, id: "my-plugin" });
    expect(r.created).toContain("tierkit.plugin.json");
    expect(r.created).toContain("commands/review.md");
    expect(r.created).toContain("modes/default.md");
    expect(r.created).toContain("rules/baseline.md");
    const manifest = JSON.parse(await fs.readFile(path.join(r.pluginDir, "tierkit.plugin.json"), "utf8"));
    expect(manifest.id).toBe("my-plugin");
    expect(manifest.permissions.editFiles).toBe(false);
    expect(manifest.freedom.level).toBe("free");
  });

  it("rejects invalid plugin ids", async () => {
    const cwd = await makeTmpDir();
    await expect(pluginNew({ cwd, id: "Bad ID!" })).rejects.toBeInstanceOf(PluginNewError);
  });

  it("refuses to overwrite existing dir without force", async () => {
    const cwd = await makeTmpDir();
    await pluginNew({ cwd, id: "p1" });
    await expect(pluginNew({ cwd, id: "p1" })).rejects.toBeInstanceOf(PluginNewError);
  });

  it("overwrites with force", async () => {
    const cwd = await makeTmpDir();
    await pluginNew({ cwd, id: "p1" });
    const r2 = await pluginNew({ cwd, id: "p1", force: true });
    expect(r2.created.length).toBeGreaterThan(0);
  });
});
