import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME, TierkitConfigSchema } from "../config/TierkitConfig.js";
import { TIERKIT_DIR, REGISTRY_FILENAME } from "../plugin/PluginRegistry.js";
import type { Target } from "../plugin/PluginManifest.js";

export interface InitProjectInput {
  cwd?: string;
  defaultTarget?: Target;
  force?: boolean;
}

export interface InitProjectResult {
  projectRoot: string;
  configPath: string;
  registryPath: string;
  created: string[];
  skipped: string[];
}

export async function initProject(input: InitProjectInput = {}): Promise<InitProjectResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const force = input.force ?? false;
  const created: string[] = [];
  const skipped: string[] = [];

  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.join(projectRoot, TIERKIT_DIR), { recursive: true });

  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  if (await exists(configPath) && !force) {
    skipped.push(CONFIG_FILENAME);
  } else {
    const config = TierkitConfigSchema.parse({
      version: "0.1",
      defaultTarget: input.defaultTarget ?? "generic",
    });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    created.push(CONFIG_FILENAME);
  }

  const registryPath = path.join(projectRoot, TIERKIT_DIR, REGISTRY_FILENAME);
  if (await exists(registryPath) && !force) {
    skipped.push(`${TIERKIT_DIR}/${REGISTRY_FILENAME}`);
  } else {
    await fs.writeFile(
      registryPath,
      JSON.stringify({ version: "0.1", plugins: [] }, null, 2) + "\n",
      "utf8",
    );
    created.push(`${TIERKIT_DIR}/${REGISTRY_FILENAME}`);
  }

  return { projectRoot, configPath, registryPath, created, skipped };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
