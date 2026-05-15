import { readRegistry, type RegistryEntry } from "../plugin/PluginRegistry.js";

export interface ListPluginsInput {
  cwd?: string;
}

export interface ListPluginsResult {
  projectRoot: string;
  plugins: RegistryEntry[];
}

export async function listPlugins(input: ListPluginsInput = {}): Promise<ListPluginsResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const registry = await readRegistry(projectRoot);
  return { projectRoot, plugins: registry.plugins };
}
