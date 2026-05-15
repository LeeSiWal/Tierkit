import type { ListModelsResult } from "@tierkit/core";

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function fmtCost(profile: ListModelsResult["entries"][number]["profile"]): string {
  const c = profile.cost;
  if (!c) return "—";
  if (c.type === "free") return "free";
  if (c.type === "flat") return `$${c.monthlyUsd}/mo`;
  return `$${c.inputUsdPerMillion}/M in · $${c.outputUsdPerMillion}/M out`;
}

export function formatModelList(result: ListModelsResult): string {
  if (!result.configFound) {
    return "No tierkit.config.json found. Run `tierkit init` first, then add `modelProfiles`.";
  }
  if (result.entries.length === 0) {
    return "Config found but no model profiles declared. Add `modelProfiles` to tierkit.config.json.";
  }

  const rows = result.entries.map((e) => ({
    id: e.id,
    kind: e.profile.kind,
    provider: e.profile.provider,
    model: e.profile.model,
    roles: e.profile.roles.join(",") || "—",
    cost: fmtCost(e.profile),
    approval: e.profile.requiresApproval ? "yes" : "no",
  }));

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    kind: Math.max(4, ...rows.map((r) => r.kind.length)),
    provider: Math.max(8, ...rows.map((r) => r.provider.length)),
    model: Math.max(5, ...rows.map((r) => r.model.length)),
    roles: Math.max(5, ...rows.map((r) => r.roles.length)),
    cost: Math.max(4, ...rows.map((r) => r.cost.length)),
  };

  const header =
    `${pad("ID", widths.id)}  ${pad("KIND", widths.kind)}  ${pad("PROVIDER", widths.provider)}  ${pad("MODEL", widths.model)}  ${pad("ROLES", widths.roles)}  ${pad("COST", widths.cost)}  APPROVAL`;
  const lines = [header];
  for (const row of rows) {
    lines.push(
      `${pad(row.id, widths.id)}  ${pad(row.kind, widths.kind)}  ${pad(row.provider, widths.provider)}  ${pad(row.model, widths.model)}  ${pad(row.roles, widths.roles)}  ${pad(row.cost, widths.cost)}  ${row.approval}`,
    );
  }
  return lines.join("\n");
}
