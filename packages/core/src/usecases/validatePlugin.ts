import fs from "node:fs/promises";
import path from "node:path";
import {
  validatePluginManifest,
  type ValidationIssue,
} from "../plugin/PluginValidator.js";
import { PLUGIN_MANIFEST_FILENAME } from "../plugin/PluginLoader.js";
import { resolveUnder } from "../fs/safePath.js";
import type { PluginManifest } from "../plugin/PluginManifest.js";

export interface ValidatePluginInput {
  pluginPath: string;
  strict?: boolean;
  cwd?: string;
}

export type ValidatePluginResult =
  | { ok: true; manifest: PluginManifest; pluginPath: string; warnings: ValidationIssue[] }
  | { ok: false; pluginPath: string; issues: ValidationIssue[] };

export async function validatePlugin(input: ValidatePluginInput): Promise<ValidatePluginResult> {
  const cwd = input.cwd ?? process.cwd();
  const absolutePluginDir = path.isAbsolute(input.pluginPath)
    ? input.pluginPath
    : path.resolve(cwd, input.pluginPath);

  let manifestRaw: unknown;
  try {
    const text = await fs.readFile(
      path.join(absolutePluginDir, PLUGIN_MANIFEST_FILENAME),
      "utf8",
    );
    manifestRaw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      pluginPath: absolutePluginDir,
      issues: [
        {
          severity: "error",
          path: PLUGIN_MANIFEST_FILENAME,
          message: `cannot read manifest: ${(err as Error).message}`,
        },
      ],
    };
  }

  const result = validatePluginManifest(manifestRaw, { strict: input.strict ?? false });
  if (!result.ok) {
    return { ok: false, pluginPath: absolutePluginDir, issues: result.issues };
  }

  const fileIssues = await checkReferencedFiles(absolutePluginDir, result.manifest);
  if (fileIssues.length > 0) {
    if (input.strict) {
      return { ok: false, pluginPath: absolutePluginDir, issues: fileIssues };
    }
    return {
      ok: false,
      pluginPath: absolutePluginDir,
      issues: fileIssues,
    };
  }

  return {
    ok: true,
    manifest: result.manifest,
    pluginPath: absolutePluginDir,
    warnings: result.warnings,
  };
}

async function checkReferencedFiles(
  pluginDir: string,
  manifest: PluginManifest,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  const refs: string[] = [
    ...manifest.components.commands.map((c) => c.file),
    ...manifest.components.modes.map((m) => m.file),
    ...manifest.components.rules,
    ...manifest.components.workflows,
    ...manifest.components.hooks,
  ];
  if (manifest.components.mcpServers) refs.push(manifest.components.mcpServers);

  for (const rel of refs) {
    let abs: string;
    try {
      abs = resolveUnder(pluginDir, rel);
    } catch (err) {
      issues.push({
        severity: "error",
        path: rel,
        message: `path traversal blocked: ${(err as Error).message}`,
      });
      continue;
    }
    try {
      await fs.access(abs);
    } catch {
      issues.push({
        severity: "error",
        path: rel,
        message: "referenced file does not exist",
      });
    }
  }

  return issues;
}
