import path from "node:path";

/**
 * Glob-ish patterns identifying files that should never be loaded as plugin content
 * or written to disk by an export adapter. The matcher is intentionally simple — it works
 * on path *basenames* and full relative paths so a plugin can't sneak through with a
 * disguised subdirectory.
 *
 * The matching strategy:
 * - For each pattern, check the path basename AND each path segment.
 * - `*` matches any run of characters within a single segment.
 * - `**` matches any number of segments.
 * - Patterns are case-insensitive on macOS / Windows-friendly filesystems but we lowercase
 *   the path for the comparison either way.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  ".env.local",
  ".env.production",
  ".env.development",
  ".envrc",
  "*.pem",
  "*.key",
  "*_rsa",
  "*_dsa",
  "*_ecdsa",
  "*_ed25519",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
  "service-account*.json",
  "**/secrets/**",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  ".npmrc",
  ".pypirc",
  ".netrc",
];

export interface SensitiveMatch {
  /** The original path (relative or basename) that was checked. */
  pathChecked: string;
  /** Patterns that matched, in priority order. */
  matched: string[];
}

/** Returns matched patterns (empty array if path is not sensitive). */
export function matchSensitive(
  rawPath: string,
  patterns: readonly string[] = DEFAULT_SENSITIVE_PATTERNS,
): string[] {
  const norm = normalize(rawPath);
  const basename = path.posix.basename(norm);
  const matched: string[] = [];
  for (const pat of patterns) {
    if (globMatch(pat.toLowerCase(), norm) || globMatch(pat.toLowerCase(), basename)) {
      matched.push(pat);
    }
  }
  return matched;
}

export function isSensitivePath(
  rawPath: string,
  patterns: readonly string[] = DEFAULT_SENSITIVE_PATTERNS,
): boolean {
  return matchSensitive(rawPath, patterns).length > 0;
}

export function describeMatch(rawPath: string): SensitiveMatch {
  return { pathChecked: rawPath, matched: matchSensitive(rawPath) };
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * Minimal glob matcher supporting `*` (single-segment) and `**` (any segments).
 * Anchored against the entire input string.
 */
function globMatch(pattern: string, text: string): boolean {
  const re = globToRegex(pattern);
  return re.test(text);
}

function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if ("().+^$|{}[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}
