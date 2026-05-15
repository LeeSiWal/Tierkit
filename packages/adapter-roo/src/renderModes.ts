import type { LoadedPlugin } from "@tierkit/core";
import { mapToolsToGroups } from "./toolGroups.js";
import type { RooGroup } from "./toolGroups.js";

export interface RooCustomMode {
  slug: string;
  name: string;
  roleDefinition: string;
  whenToUse?: string;
  customInstructions?: string;
  groups: RooGroup[];
  source: "project";
}

export interface RooModesFile {
  customModes: RooCustomMode[];
}

export interface RenderModesResult {
  file: RooModesFile;
  warnings: { pluginId: string; message: string }[];
}

/**
 * Build the `.roomodes` payload from one or more loaded plugins.
 * Slugs are always namespaced with the plugin id (`<pluginId>-<modeId>`) so multi-plugin
 * exports never collide.
 */
export function renderModes(plugins: LoadedPlugin[]): RenderModesResult {
  const customModes: RooCustomMode[] = [];
  const warnings: { pluginId: string; message: string }[] = [];

  for (const plugin of plugins) {
    for (const mode of plugin.manifest.components.modes) {
      const body = plugin.files.get(mode.file);
      if (body === undefined) {
        warnings.push({
          pluginId: plugin.manifest.id,
          message: `mode "${mode.id}" references missing file "${mode.file}" — skipped`,
        });
        continue;
      }

      const { roleDefinition, customInstructions } = splitRoleAndInstructions(body);
      const mapping = mapToolsToGroups(mode.tools, plugin.manifest.permissions);

      for (const dropped of mapping.droppedByPermission) {
        warnings.push({
          pluginId: plugin.manifest.id,
          message: `mode "${mode.id}": dropped Roo group "${dropped.group}" (${dropped.reason})`,
        });
      }
      for (const unk of mapping.unknown) {
        warnings.push({
          pluginId: plugin.manifest.id,
          message: `mode "${mode.id}": ignored unknown tool "${unk}"`,
        });
      }

      customModes.push({
        slug: `${plugin.manifest.id}-${mode.id}`,
        name: mode.name,
        roleDefinition,
        ...(customInstructions ? { customInstructions } : {}),
        groups: mapping.groups,
        source: "project",
      });
    }
  }

  return { file: { customModes }, warnings };
}

/**
 * Split a mode markdown body into a short roleDefinition and a longer customInstructions.
 *
 * Strategy: skip a leading `# Title` line; take the first non-empty paragraph as
 * `roleDefinition`; everything after that becomes `customInstructions`. If there is no
 * remaining body, `customInstructions` is undefined.
 */
export function splitRoleAndInstructions(markdown: string): {
  roleDefinition: string;
  customInstructions?: string;
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i < lines.length && lines[i]!.startsWith("# ")) i++;
  while (i < lines.length && lines[i]!.trim() === "") i++;

  const firstParaLines: string[] = [];
  while (i < lines.length && lines[i]!.trim() !== "") {
    firstParaLines.push(lines[i]!);
    i++;
  }
  const roleDefinition = firstParaLines.join("\n").trim() || markdown.trim();

  while (i < lines.length && lines[i]!.trim() === "") i++;
  const rest = lines.slice(i).join("\n").trim();
  if (rest.length === 0) return { roleDefinition };
  return { roleDefinition, customInstructions: rest };
}
