const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackRemoteAddress(addr: string | undefined): boolean {
  return typeof addr === "string" && LOOPBACK.has(addr);
}

export function loopbackControlUrl(host: string, port: number): string {
  if (host.includes(":")) return `http://[::1]:${port}`;
  return `http://127.0.0.1:${port}`;
}
