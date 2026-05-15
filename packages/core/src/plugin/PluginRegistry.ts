import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginManifestSchema } from "./PluginManifest.js";

export const REGISTRY_FILENAME = "plugins.json";
export const TIERKIT_DIR = ".tierkit";

const RegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    installedAt: z.string().datetime(),
    pluginDir: z.string().min(1),
    manifest: PluginManifestSchema,
  })
  .strict();

export const RegistryFileSchema = z
  .object({
    version: z.literal("0.1"),
    plugins: z.array(RegistryEntrySchema).default([]),
  })
  .strict();

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type RegistryFile = z.infer<typeof RegistryFileSchema>;

function registryPathFor(projectRoot: string): string {
  return path.join(projectRoot, TIERKIT_DIR, REGISTRY_FILENAME);
}

export async function readRegistry(projectRoot: string): Promise<RegistryFile> {
  const file = registryPathFor(projectRoot);
  try {
    const text = await fs.readFile(file, "utf8");
    const raw = JSON.parse(text);
    return RegistryFileSchema.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: "0.1", plugins: [] };
    }
    throw err;
  }
}

export async function writeRegistry(projectRoot: string, registry: RegistryFile): Promise<void> {
  const file = registryPathFor(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(registry, null, 2), "utf8");
}

export async function upsertEntry(projectRoot: string, entry: RegistryEntry): Promise<RegistryFile> {
  const registry = await readRegistry(projectRoot);
  const filtered = registry.plugins.filter((p) => p.id !== entry.id);
  filtered.push(entry);
  filtered.sort((a, b) => a.id.localeCompare(b.id));
  const next: RegistryFile = { version: "0.1", plugins: filtered };
  await writeRegistry(projectRoot, next);
  return next;
}

export async function removeEntry(projectRoot: string, pluginId: string): Promise<RegistryFile> {
  const registry = await readRegistry(projectRoot);
  const next: RegistryFile = {
    version: "0.1",
    plugins: registry.plugins.filter((p) => p.id !== pluginId),
  };
  await writeRegistry(projectRoot, next);
  return next;
}
