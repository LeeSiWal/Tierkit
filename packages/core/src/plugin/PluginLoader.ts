import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnder } from "../fs/safePath.js";
import type { LoadedPlugin } from "../adapter/TierkitAdapter.js";
import type { PluginManifest } from "./PluginManifest.js";
import { validatePluginManifest, type ValidationIssue } from "./PluginValidator.js";
import { TierkitError } from "../errors/TierkitError.js";
import { matchSensitive } from "../security/sensitiveFiles.js";

export const PLUGIN_MANIFEST_FILENAME = "tierkit.plugin.json";

export class PluginLoadError extends TierkitError {
  public readonly pluginDir: string;
  public readonly issues: ValidationIssue[];
  constructor(pluginDir: string, issues: ValidationIssue[]) {
    super(`failed to load plugin at ${pluginDir}: ${issues.length} issue(s)`);
    this.name = "PluginLoadError";
    this.pluginDir = pluginDir;
    this.issues = issues;
  }
}

export interface LoadPluginOptions {
  strict?: boolean;
  /**
   * Permit a plugin manifest to reference paths that match the sensitive-file blocklist
   * (`.env`, `*.pem`, `id_rsa`, ...). Defaults to false. Refusing is the safe default; the
   * override exists so an internal-tooling plugin author who deliberately ships sample
   * secrets-handling rules can opt in explicitly.
   */
  allowSensitive?: boolean;
}

export async function loadPluginFromDirectory(
  pluginDir: string,
  options: LoadPluginOptions = {},
): Promise<LoadedPlugin> {
  const absolutePluginDir = path.resolve(pluginDir);
  const manifestPath = path.join(absolutePluginDir, PLUGIN_MANIFEST_FILENAME);

  let manifestRaw: unknown;
  try {
    const text = await fs.readFile(manifestPath, "utf8");
    manifestRaw = JSON.parse(text);
  } catch (err) {
    throw new PluginLoadError(absolutePluginDir, [
      {
        severity: "error",
        path: PLUGIN_MANIFEST_FILENAME,
        message: `cannot read manifest: ${(err as Error).message}`,
      },
    ]);
  }

  const result = validatePluginManifest(manifestRaw, { strict: options.strict ?? false });
  if (!result.ok) {
    throw new PluginLoadError(absolutePluginDir, result.issues);
  }

  const manifest = result.manifest;
  const files = await loadReferencedFiles(absolutePluginDir, manifest, options.allowSensitive ?? false);

  return { manifest, pluginDir: absolutePluginDir, files };
}

async function loadReferencedFiles(
  pluginDir: string,
  manifest: PluginManifest,
  allowSensitive: boolean,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const missing: ValidationIssue[] = [];

  const referencedPaths: string[] = [
    ...manifest.components.commands.map((c) => c.file),
    ...manifest.components.modes.map((m) => m.file),
    ...manifest.components.rules,
    ...manifest.components.workflows,
    ...manifest.components.hooks,
  ];
  if (manifest.components.mcpServers) referencedPaths.push(manifest.components.mcpServers);

  for (const rel of referencedPaths) {
    if (!allowSensitive) {
      const matched = matchSensitive(rel);
      if (matched.length > 0) {
        missing.push({
          severity: "error",
          path: rel,
          message: `plugin references a sensitive path matching pattern(s) [${matched.join(", ")}]. Pass allowSensitive=true if this is intentional.`,
        });
        continue;
      }
    }
    let abs: string;
    try {
      abs = resolveUnder(pluginDir, rel);
    } catch (err) {
      missing.push({
        severity: "error",
        path: rel,
        message: `path traversal blocked: ${(err as Error).message}`,
      });
      continue;
    }
    try {
      const contents = await fs.readFile(abs, "utf8");
      files.set(rel, contents);
    } catch (err) {
      missing.push({
        severity: "error",
        path: rel,
        message: `referenced file not readable: ${(err as Error).message}`,
      });
    }
  }

  if (missing.length > 0) {
    throw new PluginLoadError(pluginDir, missing);
  }

  return files;
}
