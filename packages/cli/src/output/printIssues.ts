import type { ValidationIssue } from "@tierkit/core";

export function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "";
  return issues
    .map((i) => {
      const sev = i.severity === "error" ? "ERROR" : "WARN ";
      return `  ${sev}  ${i.path}: ${i.message}`;
    })
    .join("\n");
}
