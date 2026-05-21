export interface PatchRisk {
  level: "low" | "medium" | "high";
  reasons: string[];
}

const HIGH_RISK_PATH_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)dockerfile/i,
  /(^|\/)docker-compose\.yml$/,
  /(^|\/)tierkit\.config\.json$/,
  /\.sh$/,
  /\.ps1$/,
  /\.bat$/,
];

export function scorePatchRisk(input: {
  files: Array<{ path: string; beforeExists: boolean }>;
}): PatchRisk {
  const reasons: string[] = [];
  let level: PatchRisk["level"] = "low";

  for (const f of input.files) {
    if (HIGH_RISK_PATH_PATTERNS.some((r) => r.test(f.path))) {
      level = "high";
      reasons.push(`high-risk path: ${f.path}`);
    } else {
      // Any mutation to source files is at least medium risk in MCP context
      if (level === "low") level = "medium";
      reasons.push(f.beforeExists ? `modifies file: ${f.path}` : `creates file: ${f.path}`);
    }
  }

  if (reasons.length === 0) reasons.push("no-op");
  return { level, reasons };
}
