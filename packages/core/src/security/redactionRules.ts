export interface RedactionRule {
  id: string;
  description: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Default redaction rules. Each pattern is intentionally specific — we accept misses to avoid
 * false-positives in source code (which would otherwise mangle innocent variable names).
 * Adding a new rule? Cover it with a test in `SecretRedactor.test.ts` AND prove a near-miss
 * (a similar-looking innocent string) is left untouched.
 */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  {
    // Order matters: anthropic must run before openai because `sk-ant-…` also matches the
    // looser openai pattern. The negative lookahead in openai-api-key is a belt-and-braces
    // guard so a future reorder doesn't quietly re-introduce the bug.
    id: "anthropic-api-key",
    description: "Anthropic API key",
    pattern: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED:anthropic-api-key]",
  },
  {
    id: "openai-api-key",
    description: "OpenAI-style API key (sk-…)",
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED:openai-api-key]",
  },
  {
    id: "aws-access-key",
    description: "AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws-access-key]",
  },
  {
    id: "aws-secret-key",
    description: "AWS secret access key (presented as kv pair)",
    pattern: /(aws_secret_access_key\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{40}/gi,
    replacement: "$1[REDACTED:aws-secret-key]",
  },
  {
    id: "github-token",
    description: "GitHub fine-grained or classic token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    id: "gcp-service-account",
    description: "Google Cloud service account JSON key marker",
    pattern: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key-block]",
  },
  {
    id: "openssh-private-key",
    description: "OpenSSH / PEM private key blocks",
    pattern: /-----BEGIN (?:RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key-block]",
  },
  {
    id: "slack-token",
    description: "Slack bot/user/app token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED:slack-token]",
  },
  {
    id: "stripe-secret-key",
    description: "Stripe live or test secret key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    replacement: "[REDACTED:stripe-secret-key]",
  },
  {
    id: "stripe-restricted-key",
    description: "Stripe restricted key",
    pattern: /\brk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    replacement: "[REDACTED:stripe-restricted-key]",
  },
  {
    id: "google-api-key",
    description: "Google API key (AIza…)",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[REDACTED:google-api-key]",
  },
  {
    id: "azure-key",
    description: "Azure storage key (base64 88 chars ending with ==)",
    pattern: /\b[A-Za-z0-9+/]{86}==\b/g,
    replacement: "[REDACTED:azure-key-candidate]",
  },
  {
    id: "credentials-in-url",
    description: "Basic-auth credentials embedded in a URL",
    pattern: /\b(https?:\/\/)([^\s:/@]+):([^\s:/@]+)@/g,
    replacement: "$1[REDACTED:user]:[REDACTED:pass]@",
  },
  {
    id: "generic-bearer-header",
    description: "Authorization: Bearer … header line",
    pattern: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]{8,}/gi,
    replacement: "$1[REDACTED:bearer-token]",
  },
  {
    id: "jwt-like",
    description: "Three-segment dot-separated base64-ish token (JWT shape)",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED:jwt-like]",
  },
];

export function getDefaultRedactionRules(): readonly RedactionRule[] {
  return DEFAULT_REDACTION_RULES;
}
