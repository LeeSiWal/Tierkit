/**
 * Tierkit policy gate helpers — hit the daemon's existing `/v1/check/*` endpoints so
 * tools enforce the same rules as `/v1/llm-call` does for caller-supplied tool commands.
 *
 * Keeping these as HTTP calls (rather than direct imports of `@tierkit/core` usecases)
 * decouples the agent package from Tierkit's internal API surface. The agent only needs
 * to know how to speak the public HTTP contract.
 */

const FETCH_TIMEOUT_MS = 1500;

export interface SensitivePathResult {
  blocked: boolean;
  reason?: string;
}

export async function gateSensitivePath(
  tierkitBaseUrl: string,
  pathToCheck: string,
): Promise<SensitivePathResult> {
  try {
    const res = await fetch(`${tierkitBaseUrl}/v1/check/path`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: pathToCheck }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // If the gate is down, we fail-OPEN (allow). The alternative is the agent
      // refusing every read when Tierkit's check endpoint is flaky, which is worse than
      // a temporary loss of policy enforcement. Production policy mode could flip this
      // to fail-CLOSED later.
      return { blocked: false };
    }
    const body = (await res.json()) as { blocked?: boolean; reason?: string };
    return { blocked: Boolean(body.blocked), ...(body.reason ? { reason: body.reason } : {}) };
  } catch {
    return { blocked: false };
  }
}

export interface CommandClassification {
  severity: "ok" | "warn" | "block";
  matched: { id: string; description: string }[];
}

export async function gateDangerousCommand(
  tierkitBaseUrl: string,
  command: string,
): Promise<CommandClassification> {
  try {
    const res = await fetch(`${tierkitBaseUrl}/v1/check/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { severity: "ok", matched: [] };
    return (await res.json()) as CommandClassification;
  } catch {
    return { severity: "ok", matched: [] };
  }
}
