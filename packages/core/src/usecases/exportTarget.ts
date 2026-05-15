import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnder } from "../fs/safePath.js";
import { readRegistry } from "../plugin/PluginRegistry.js";
import { loadPluginFromDirectory } from "../plugin/PluginLoader.js";
import type { LoadedPlugin, TierkitAdapter } from "../adapter/TierkitAdapter.js";
import type { ExportResult } from "../adapter/ExportResult.js";
import { GenericMarkdownAdapter } from "../adapter/GenericMarkdownAdapter.js";
import type { Target } from "../plugin/PluginManifest.js";
import { loadConfig } from "../config/loadConfig.js";
import { matchSensitive } from "../security/sensitiveFiles.js";

export interface ExportTargetInput {
  target: Target;
  outDir: string;
  cwd?: string;
  /** Override which plugins are exported. If omitted, all registry plugins are exported. */
  pluginIds?: string[];
  /** Custom adapters by target. Defaults to GenericMarkdownAdapter for `generic`. */
  adapters?: Partial<Record<Target, TierkitAdapter>>;
  /** When true, do not write files to disk — only return the result. */
  dryRun?: boolean;
  /**
   * Permit adapters to write to paths that match the sensitive-file blocklist
   * (`.env`, `*.pem`, …). Default false — refusing is the safe stance. The override exists
   * for advanced workflows that deliberately export a `.envrc` or similar.
   */
  allowSensitive?: boolean;
}

export interface ExportTargetResult extends ExportResult {
  projectRoot: string;
  outDir: string;
  written: string[];
}

export async function exportTarget(input: ExportTargetInput): Promise<ExportTargetResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const adapters: Partial<Record<Target, TierkitAdapter>> = {
    generic: new GenericMarkdownAdapter(),
    ...(input.adapters ?? {}),
  };
  const adapter = adapters[input.target];
  if (!adapter) {
    throw new Error(
      `no adapter registered for target "${input.target}". Available targets: ${Object.keys(adapters).join(", ")}`,
    );
  }

  const registry = await readRegistry(projectRoot);
  const candidates = input.pluginIds
    ? registry.plugins.filter((p) => input.pluginIds!.includes(p.id))
    : registry.plugins;

  if (candidates.length === 0) {
    return {
      target: input.target,
      files: [],
      warnings: [
        {
          message:
            "no plugins to export. install plugins first with 'tierkit plugin install <path>'.",
        },
      ],
      projectRoot,
      outDir: input.outDir,
      written: [],
    };
  }

  const loaded: LoadedPlugin[] = [];
  for (const entry of candidates) {
    const plugin = await loadPluginFromDirectory(entry.pluginDir);
    loaded.push(plugin);
  }

  const absoluteOut = path.isAbsolute(input.outDir)
    ? input.outDir
    : path.resolve(projectRoot, input.outDir);

  const cfg = await loadConfig(projectRoot);
  const result = await adapter.export({
    plugins: loaded,
    outDir: absoluteOut,
    ...(cfg.found ? { config: cfg.config } : {}),
  });
  const written: string[] = [];
  const allowSensitive = input.allowSensitive ?? false;

  // Pre-filter sensitive output paths regardless of dry-run; surface them as warnings even
  // when --allow-sensitive is set, and as blocking warnings otherwise.
  const blockedFiles: string[] = [];
  const filesToWrite = result.files.filter((file) => {
    const matched = matchSensitive(file.path);
    if (matched.length === 0) return true;
    if (allowSensitive) {
      result.warnings.push({
        ...(file.pluginId ? { pluginId: file.pluginId } : {}),
        message: `output path "${file.path}" matches sensitive pattern(s) [${matched.join(", ")}] — written because allowSensitive=true`,
      });
      return true;
    }
    blockedFiles.push(file.path);
    result.warnings.push({
      ...(file.pluginId ? { pluginId: file.pluginId } : {}),
      message: `refused to write "${file.path}" — matches sensitive pattern(s) [${matched.join(", ")}]. Pass allowSensitive=true to override.`,
    });
    return false;
  });

  if (!input.dryRun) {
    await fs.mkdir(absoluteOut, { recursive: true });
    for (const file of filesToWrite) {
      const abs = resolveUnder(absoluteOut, file.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.contents, file.encoding ?? "utf8");
      written.push(abs);
    }
  }

  return {
    ...result,
    files: filesToWrite,
    projectRoot,
    outDir: absoluteOut,
    written,
  };
}
