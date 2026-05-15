import path from "node:path";
import type { AdapterExportInput, TierkitAdapter, LoadedPlugin } from "./TierkitAdapter.js";
import type { ExportFile, ExportResult, ExportWarning } from "./ExportResult.js";
import { listGrantedPermissions } from "../security/Permission.js";

/**
 * Generic markdown adapter: dumps a plugin's components into a target-neutral folder structure.
 * Output shape per plugin (under `outDir/<pluginId>/`):
 *
 * - README.md             — manifest summary + permission table
 * - commands/<name>.md
 * - modes/<id>.md
 * - rules/<original-path>
 * - workflows/<original-basename>
 * - hooks/<original-basename>
 * - mcp/servers.json      (if mcpServers configured)
 *
 * This is intentionally simple — it proves the export pipeline end-to-end without committing
 * to any tool-specific output format yet.
 */
export class GenericMarkdownAdapter implements TierkitAdapter {
  readonly target = "generic" as const;
  readonly name = "Generic Markdown";
  readonly description = "Tool-neutral markdown dump of a Tierkit plugin.";

  async export(input: AdapterExportInput): Promise<ExportResult> {
    const files: ExportFile[] = [];
    const warnings: ExportWarning[] = [];
    for (const plugin of input.plugins) {
      this.exportOne(plugin, files, warnings);
    }
    return { target: this.target, files, warnings };
  }

  private exportOne(plugin: LoadedPlugin, files: ExportFile[], warnings: ExportWarning[]): void {
    const root = plugin.manifest.id;

    files.push({
      pluginId: plugin.manifest.id,
      path: path.posix.join(root, "README.md"),
      contents: renderReadme(plugin),
    });

    for (const cmd of plugin.manifest.components.commands) {
      const body = plugin.files.get(cmd.file);
      if (body === undefined) {
        warnings.push({
          pluginId: plugin.manifest.id,
          message: `command "${cmd.name}" references missing file "${cmd.file}"`,
        });
        continue;
      }
      files.push({
        pluginId: plugin.manifest.id,
        path: path.posix.join(root, "commands", `${cmd.name}.md`),
        contents: prependFrontmatter(body, {
          name: cmd.name,
          description: cmd.description,
          category: cmd.category,
          plugin: plugin.manifest.id,
        }),
      });
    }

    for (const mode of plugin.manifest.components.modes) {
      const body = plugin.files.get(mode.file);
      if (body === undefined) {
        warnings.push({
          pluginId: plugin.manifest.id,
          message: `mode "${mode.id}" references missing file "${mode.file}"`,
        });
        continue;
      }
      files.push({
        pluginId: plugin.manifest.id,
        path: path.posix.join(root, "modes", `${mode.id}.md`),
        contents: prependFrontmatter(body, {
          id: mode.id,
          name: mode.name,
          role: mode.role,
          tools: mode.tools.join(", "),
          plugin: plugin.manifest.id,
        }),
      });
    }

    for (const rel of plugin.manifest.components.rules) {
      const body = plugin.files.get(rel);
      if (body === undefined) {
        warnings.push({
          pluginId: plugin.manifest.id,
          message: `rule references missing file "${rel}"`,
        });
        continue;
      }
      files.push({
        pluginId: plugin.manifest.id,
        path: path.posix.join(root, "rules", path.basename(rel)),
        contents: body,
      });
    }

    for (const rel of plugin.manifest.components.workflows) {
      const body = plugin.files.get(rel);
      if (body === undefined) continue;
      files.push({
        pluginId: plugin.manifest.id,
        path: path.posix.join(root, "workflows", path.basename(rel)),
        contents: body,
      });
    }

    for (const rel of plugin.manifest.components.hooks) {
      const body = plugin.files.get(rel);
      if (body === undefined) continue;
      files.push({
        pluginId: plugin.manifest.id,
        path: path.posix.join(root, "hooks", path.basename(rel)),
        contents: body,
      });
    }

    if (plugin.manifest.components.mcpServers) {
      const body = plugin.files.get(plugin.manifest.components.mcpServers);
      if (body !== undefined) {
        files.push({
          pluginId: plugin.manifest.id,
          path: path.posix.join(root, "mcp", "servers.json"),
          contents: body,
        });
      }
    }
  }
}

function renderReadme(plugin: LoadedPlugin): string {
  const m = plugin.manifest;
  const perms = listGrantedPermissions(m.permissions);
  const permTable =
    perms.length === 0
      ? "_(no permissions requested)_"
      : perms.map((p) => `- \`${p}\``).join("\n");

  const targets = m.compatibility.targets.map((t) => `\`${t}\``).join(", ");
  const lines: string[] = [
    `# ${m.name}`,
    "",
    m.description,
    "",
    `- **id**: \`${m.id}\``,
    `- **version**: ${m.version}`,
    `- **author**: ${m.author}`,
    `- **license**: ${m.license}`,
    `- **freedom**: ${m.freedom.level}`,
    `- **targets**: ${targets}`,
    `- **tierkit compatibility**: \`${m.compatibility.tierkit}\``,
    "",
    "## Permissions",
    "",
    permTable,
  ];
  return lines.join("\n") + "\n";
}

function prependFrontmatter(body: string, meta: Record<string, string>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    lines.push(`${k}: ${escapeYaml(v)}`);
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

function escapeYaml(v: string): string {
  if (/[":#\n]/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}
