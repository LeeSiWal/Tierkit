import type { CheckCommandResult, CheckPathResult, CheckRedactResult } from "@tierkit/core";

export function formatRedactResult(r: CheckRedactResult, printRedacted: boolean): string {
  const lines: string[] = [
    `Redaction of: ${r.filePath}`,
    `  bytes in  ${r.bytesIn}`,
    `  bytes out ${r.bytesOut}`,
  ];
  if (r.hits.length === 0) {
    lines.push("  hits      none — file appears clean");
  } else {
    lines.push(`  hits      ${r.hits.length} rule(s) triggered`);
    for (const h of r.hits) {
      lines.push(`            - ${h.ruleId} × ${h.count}`);
    }
  }
  if (printRedacted) {
    lines.push("");
    lines.push("--- redacted contents ---");
    lines.push(r.redacted);
  }
  return lines.join("\n");
}

export function formatCommandCheck(r: CheckCommandResult): string {
  const sev = r.severity === "block" ? "BLOCK" : r.severity === "warn" ? "WARN " : "OK   ";
  const lines: string[] = [`Command:  ${r.command}`, `Severity: ${sev}`];
  if (r.matched.length === 0) {
    lines.push("Reasons:  (no dangerous patterns matched)");
  } else {
    lines.push(`Reasons:  ${r.matched.length} rule(s) matched`);
    for (const m of r.matched) {
      const tag = m.severity === "block" ? "BLOCK" : "WARN ";
      lines.push(`  [${tag}] ${m.id}: ${m.description}`);
    }
  }
  if (r.severity === "block") {
    lines.push("");
    lines.push("⚠️  This command must NEVER be invoked without explicit human approval.");
  } else if (r.severity === "warn") {
    lines.push("");
    lines.push("⚠️  This command has side effects that are hard or impossible to reverse. Surface what will run.");
  }
  return lines.join("\n");
}

export function formatPathCheck(r: CheckPathResult): string {
  const lines: string[] = [`Path:      ${r.pathChecked}`, `Sensitive: ${r.sensitive ? "YES" : "no"}`];
  if (r.sensitive) {
    lines.push(`Patterns:  ${r.matchedPatterns.join(", ")}`);
    lines.push("");
    lines.push("⚠️  Tierkit will refuse to load this path as plugin content or write it from an adapter, unless --allow-sensitive is passed.");
  }
  return lines.join("\n");
}
