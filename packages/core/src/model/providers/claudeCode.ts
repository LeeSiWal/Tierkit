import type { ModelProfile } from "../ModelProfile.js";
import { SubscriptionCliProvider, type SubscriptionCliParsedResult } from "./subscriptionCli.js";

function pickNonNegativeFinite(...vs: unknown[]): number | undefined {
  for (const v of vs) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

/**
 * Claude Code CLI subprocess provider. Invokes `claude` (or whatever
 * `transport.command` is set to) with the args from `transport.args`
 * (defaulting to `["-p", "--output-format", "json"]` via the bundled profile).
 *
 * Parser is intentionally permissive — `claude --output-format=json` payload
 * shape can shift between releases. Unknown shapes fall through to
 * "treat stdout as content, estimate tokens" via the base class.
 */
export class ClaudeCodeProvider extends SubscriptionCliProvider {
  buildArgs(profile: ModelProfile): string[] {
    return [...(profile.transport?.args ?? [])];
  }

  parseStdout(stdout: string): SubscriptionCliParsedResult {
    const trimmed = stdout.trim();
    let raw: unknown;
    try { raw = JSON.parse(trimmed); }
    catch { return { content: trimmed, raw: trimmed }; }

    const r = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : null;
    const content =
      r && (
        (typeof r.result === "string"  && r.result) ||
        (typeof r.content === "string" && r.content) ||
        (typeof r.text === "string"    && r.text) ||
        (typeof r.message === "string" && r.message)
      ) || trimmed;

    const usage = (r && typeof r.usage === "object" && r.usage !== null)
      ? (r.usage as Record<string, unknown>) : undefined;
    const inputTokens  = pickNonNegativeFinite(usage?.input_tokens,  usage?.inputTokens);
    const outputTokens = pickNonNegativeFinite(usage?.output_tokens, usage?.outputTokens);

    return {
      content: typeof content === "string" ? content : JSON.stringify(content),
      ...(inputTokens  !== undefined ? { inputTokens  } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      raw,
    };
  }
}
