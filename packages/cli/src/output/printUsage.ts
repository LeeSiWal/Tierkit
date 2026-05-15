import type { UsageResult } from "@tierkit/core";

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function formatUsage(r: UsageResult): string {
  const lines: string[] = [];
  lines.push(`Usage log:  ${r.usageLogPath}`);
  lines.push(`Total calls: ${r.summary.totalCalls} (${r.summary.successfulCalls} ok, ${r.summary.failedCalls} failed)`);
  lines.push(
    `Tokens:      ${r.summary.totalInputTokens.toLocaleString()} in / ${r.summary.totalOutputTokens.toLocaleString()} out`,
  );
  lines.push(`Total cost:  $${r.summary.totalCostUsd.toFixed(4)}`);
  lines.push("");
  if (r.summary.byProfile.size === 0) {
    lines.push("(no per-profile usage)");
    return lines.join("\n");
  }
  const rows = [...r.summary.byProfile.entries()].map(([id, s]) => ({
    id,
    calls: String(s.calls),
    inTok: s.inputTokens.toLocaleString(),
    outTok: s.outputTokens.toLocaleString(),
    cost: `$${s.costUsd.toFixed(4)}`,
  }));
  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    calls: Math.max(5, ...rows.map((r) => r.calls.length)),
    inTok: Math.max(5, ...rows.map((r) => r.inTok.length)),
    outTok: Math.max(6, ...rows.map((r) => r.outTok.length)),
  };
  lines.push(
    `${pad("PROFILE", widths.id)}  ${pad("CALLS", widths.calls)}  ${pad("IN", widths.inTok)}  ${pad("OUT", widths.outTok)}  COST`,
  );
  for (const row of rows) {
    lines.push(
      `${pad(row.id, widths.id)}  ${pad(row.calls, widths.calls)}  ${pad(row.inTok, widths.inTok)}  ${pad(row.outTok, widths.outTok)}  ${row.cost}`,
    );
  }
  return lines.join("\n");
}
