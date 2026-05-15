import type { ExportTargetResult } from "@tierkit/core";
import path from "node:path";

export function formatExportResult(result: ExportTargetResult): string {
  const lines: string[] = [];
  lines.push(`Exported ${result.files.length} file(s) for target "${result.target}" → ${result.outDir}`);

  if (result.written.length > 0) {
    for (const abs of result.written) {
      const rel = path.relative(result.projectRoot, abs);
      lines.push(`  wrote  ${rel}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) {
      const prefix = w.pluginId ? `[${w.pluginId}] ` : "";
      lines.push(`  - ${prefix}${w.message}`);
    }
  }

  return lines.join("\n");
}
