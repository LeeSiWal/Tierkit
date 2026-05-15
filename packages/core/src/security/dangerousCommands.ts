export type DangerSeverity = "block" | "warn" | "ok";

export interface DangerRule {
  id: string;
  description: string;
  severity: "block" | "warn";
  pattern: RegExp;
}

/**
 * Default classifier rules. Each rule documents *why* the command is dangerous so the CLI
 * output and any policy-injected approval prompt can explain the risk to the user.
 *
 * Stance:
 * - `block` — the command should NEVER run automatically. Always require explicit human approval.
 * - `warn`  — the command CAN run with the user's awareness, but the agent should not invoke it
 *             without surfacing what will happen.
 *
 * We intentionally accept misses to keep false-positives low — pattern matching cannot detect
 * every misuse, and the agent loop should layer additional checks. These rules are a safety net,
 * not a replacement for human judgement.
 */
export const DEFAULT_DANGER_RULES: readonly DangerRule[] = [
  {
    id: "rm-rf-root",
    description: "Recursive force-delete of the filesystem root or home",
    severity: "block",
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b[^|;&]*\s+(\/|~|\$HOME|\.\.\/\.\.\/)/i,
  },
  {
    id: "rm-rf-asterisk",
    description: "Recursive force-delete against a glob expansion (rm -rf *)",
    severity: "block",
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:[.~/]\s*)?\*\s*$/m,
  },
  {
    id: "rm-rf-generic",
    description: "Any rm -rf invocation",
    severity: "warn",
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/i,
  },
  {
    id: "git-reset-hard",
    description: "git reset --hard discards local changes irreversibly",
    severity: "warn",
    pattern: /\bgit\s+reset\s+--hard\b/i,
  },
  {
    id: "git-clean-fd",
    description: "git clean -fd removes untracked files irreversibly",
    severity: "warn",
    pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*\b/i,
  },
  {
    id: "git-push-force",
    description: "Force-push overwrites remote history",
    severity: "warn",
    pattern: /\bgit\s+push\s+(?:--force\b|-f\b)/i,
  },
  {
    id: "npm-publish",
    description: "Publishing a package is irreversible",
    severity: "warn",
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i,
  },
  {
    id: "curl-pipe-shell",
    description: "Piping remote content directly into a shell executes untrusted code",
    severity: "block",
    pattern: /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:bash|sh|zsh)\b/i,
  },
  {
    id: "chmod-777",
    description: "Granting world-write permission is a security smell",
    severity: "warn",
    pattern: /\bchmod\s+(?:-R\s+)?(?:0?777|a\+rwx)\b/i,
  },
  {
    id: "dd-of-device",
    description: "dd writing to a device path can destroy disks",
    severity: "block",
    pattern: /\bdd\s+[^\n]*\bof=\/dev\/(?:disk|sd|nvme|hd)/i,
  },
  {
    id: "kill-init",
    description: "Killing PID 1 or sending signals to init",
    severity: "block",
    pattern: /\bkill\s+(?:-[0-9A-Z]+\s+)?-?1\b/,
  },
  {
    id: "mkfs",
    description: "Filesystem reformat is destructive",
    severity: "block",
    pattern: /\bmkfs(?:\.\w+)?\b/i,
  },
  {
    id: "shutdown-reboot",
    description: "Shutting down or rebooting the host",
    severity: "block",
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  },
  {
    id: "drop-database",
    description: "Dropping a database table or schema",
    severity: "warn",
    pattern: /\bDROP\s+(?:DATABASE|TABLE|SCHEMA)\b/i,
  },
  {
    id: "truncate-database",
    description: "Truncating a database table removes all rows",
    severity: "warn",
    pattern: /\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_]/i,
  },
];

export interface CommandClassification {
  command: string;
  severity: DangerSeverity;
  matched: { id: string; description: string; severity: "block" | "warn" }[];
}

/**
 * Classify a shell command. Result `severity` is the maximum severity of any matched rule:
 * `block` > `warn` > `ok`. Returns all matched rules so the caller can show every reason.
 */
export function classifyCommand(
  command: string,
  rules: readonly DangerRule[] = DEFAULT_DANGER_RULES,
): CommandClassification {
  const matched: CommandClassification["matched"] = [];
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      matched.push({ id: rule.id, description: rule.description, severity: rule.severity });
    }
  }
  let severity: DangerSeverity = "ok";
  for (const m of matched) {
    if (m.severity === "block") {
      severity = "block";
      break;
    }
    if (m.severity === "warn") severity = "warn";
  }
  return { command, severity, matched };
}
