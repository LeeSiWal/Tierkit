import type { RegistryEntry } from "@tierkit/core";

export function formatPluginList(plugins: RegistryEntry[]): string {
  if (plugins.length === 0) {
    return "No plugins installed. Try: tierkit plugin install <path>";
  }
  const rows = plugins.map((p) => ({
    id: p.id,
    version: p.version,
    freedom: p.manifest.freedom.level,
    targets: p.manifest.compatibility.targets.join(","),
  }));

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    freedom: Math.max(7, ...rows.map((r) => r.freedom.length)),
  };

  const header =
    `${pad("ID", widths.id)}  ${pad("VERSION", widths.version)}  ${pad("FREEDOM", widths.freedom)}  TARGETS`;
  const lines = [header];
  for (const row of rows) {
    lines.push(
      `${pad(row.id, widths.id)}  ${pad(row.version, widths.version)}  ${pad(row.freedom, widths.freedom)}  ${row.targets}`,
    );
  }
  return lines.join("\n");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
