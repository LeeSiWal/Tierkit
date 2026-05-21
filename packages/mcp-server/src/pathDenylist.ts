import path from "node:path";

/**
 * Hard denylist. Paths matching any of these are refused at the tool boundary
 * (read_file/run_command/etc), not just filtered from listings. The patterns
 * are checked against the relative-to-workspace path.
 */
export const DENIED_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,                      // .env, .env.production, etc.
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa(\.|$)/i,
  /(^|\/)id_dsa(\.|$)/i,
  /(^|\/)id_ed25519(\.|$)/i,
  /(^|\/)id_ecdsa(\.|$)/i,
  /(^|\/)secrets\.json$/i,
  /(^|\/)\.tierkit\/runtime\//i,
];

export function isDenied(relPath: string): boolean {
  const normalized = relPath.replace(/^\/+/, "").split(path.sep).join("/");
  return DENIED_PATTERNS.some((p) => p.test(normalized));
}
