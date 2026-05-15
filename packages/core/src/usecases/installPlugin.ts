import fs from "node:fs/promises";
import path from "node:path";
import {
  TIERKIT_DIR,
  readRegistry,
  upsertEntry,
  type RegistryEntry,
} from "../plugin/PluginRegistry.js";
import { loadPluginFromDirectory } from "../plugin/PluginLoader.js";
import { resolveUnder } from "../fs/safePath.js";
import { TierkitError } from "../errors/TierkitError.js";

export const PLUGIN_STORE_SUBDIR = "plugins";

export interface InstallPluginInput {
  pluginPath: string;
  cwd?: string;
  /** If true, replace any existing installation with the same id. */
  force?: boolean;
}

export interface InstallPluginResult {
  pluginId: string;
  version: string;
  installedPath: string;
  replacedPrevious: boolean;
  warnings: { message: string }[];
}

export class PluginInstallError extends TierkitError {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallError";
  }
}

export async function installPlugin(input: InstallPluginInput): Promise<InstallPluginResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const sourceDir = path.isAbsolute(input.pluginPath)
    ? input.pluginPath
    : path.resolve(projectRoot, input.pluginPath);

  const loaded = await loadPluginFromDirectory(sourceDir);
  const manifest = loaded.manifest;

  const registry = await readRegistry(projectRoot);
  const previous = registry.plugins.find((p) => p.id === manifest.id);

  const storeRoot = path.join(projectRoot, TIERKIT_DIR, PLUGIN_STORE_SUBDIR);
  const installedPath = path.join(storeRoot, manifest.id);

  if (previous && !input.force) {
    throw new PluginInstallError(
      `plugin "${manifest.id}" is already installed (v${previous.version}). Pass force=true to replace.`,
    );
  }

  await fs.rm(installedPath, { recursive: true, force: true });
  await copyPluginFiles(sourceDir, installedPath, loaded);

  const entry: RegistryEntry = {
    id: manifest.id,
    version: manifest.version,
    installedAt: new Date().toISOString(),
    pluginDir: installedPath,
    manifest,
  };

  await upsertEntry(projectRoot, entry);

  return {
    pluginId: manifest.id,
    version: manifest.version,
    installedPath,
    replacedPrevious: Boolean(previous),
    warnings: [],
  };
}

async function copyPluginFiles(
  sourceDir: string,
  destDir: string,
  loaded: { files: Map<string, string> },
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });

  // copy the manifest verbatim
  await fs.copyFile(
    path.join(sourceDir, "tierkit.plugin.json"),
    path.join(destDir, "tierkit.plugin.json"),
  );

  // copy each referenced file through safePath
  for (const [rel, contents] of loaded.files.entries()) {
    const destAbs = resolveUnder(destDir, rel);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.writeFile(destAbs, contents, "utf8");
  }
}
