/**
 * Canonicalize the user-configured `tierkit.baseUrl` into a loopback control
 * URL. Phase 1's control endpoints reject non-loopback callers; the extension
 * must always use this canonical URL for control calls.
 *
 * Pure. NO `vscode` import. Unit-testable without the VS Code runtime.
 *
 * NOTE: This canonicalization rescues daemons bound to 127.0.0.1, ::1,
 * 0.0.0.0, or :: only. A daemon bound only to a specific LAN interface
 * (e.g. 192.168.1.50) is NOT reachable through this flow — see
 * docs/ANTHROPIC_GATEWAY.md.
 */
export function controlBaseUrlFromConfiguredBaseUrl(configuredBaseUrl: string): string {
  const url = new URL(configuredBaseUrl);
  if (configuredBaseUrl.includes("[")) {
    return `http://[::1]:${url.port}`;
  }
  return `http://127.0.0.1:${url.port}`;
}
