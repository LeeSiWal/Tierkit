import path from "node:path";

/**
 * Hard denylist. Paths matching any of these are refused at the tool boundary
 * (read_file/run_command/etc), not just filtered from listings. The patterns
 * are checked against the relative-to-workspace path.
 */
export const DENIED_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/,                       // .env, .env.production, etc.
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)id_dsa(\.|$)/,
  /(^|\/)id_ed25519(\.|$)/,
  /(^|\/)id_ecdsa(\.|$)/,
  /(^|\/)secrets\.json$/,
  /(^|\/)\.tierkit\/runtime\//,
];

export function isDenied(relPath: string): boolean {
  const normalized = relPath.replace(/^\/+/, "").split(path.sep).join("/");
  return DENIED_PATTERNS.some((p) => p.test(normalized));
}
