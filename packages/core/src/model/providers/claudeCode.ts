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
 *
 * Streaming: uses `--output-format=stream-json --verbose` which makes the CLI
 * emit newline-delimited JSON events as tokens are produced.
 */
export class ClaudeCodeProvider extends SubscriptionCliProvider {
  buildArgs(profile: ModelProfile): string[] {
    return [...(profile.transport?.args ?? [])];
  }

  /**
   * Returns args for streaming mode: replaces any `--output-format <X>` or
   * `--output-format=X` with `--output-format stream-json --verbose`.
   *
   * Claude Code requires `--verbose` when using `stream-json` to enable the
   * streaming event output.
   */
  override streamArgs(profile: ModelProfile): string[] {
    const baseArgs = profile.transport?.args ?? [];
    const out: string[] = [];
    for (let i = 0; i < baseArgs.length; i++) {
      const a = baseArgs[i]!;
      if (a === "--output-format") {
        // Skip the flag and its value argument
        i++;
        continue;
      }
      if (a.startsWith("--output-format=")) continue;
      out.push(a);
    }
    out.push("--output-format", "stream-json", "--verbose");
    return out;
  }

  /**
   * Parse one line from `--output-format=stream-json` stdout.
   *
   * Observed event shapes (permissive — Claude Code versions may vary):
   *   - {type:"assistant", message:{content:[{type:"text", text:"..."}]}}
   *   - {type:"content_block_delta", delta:{type:"text_delta", text:"..."}}
   *   - {type:"system", ...}    → no text, skip
   *   - {type:"result", ...}    → full accumulated text; skip to avoid double-emit
   *                               (caller picks usage from parseStdout on full buffer)
   *
   * Returns the text delta string, or undefined if this line carries no text.
   */
  override parseStreamLine(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { return undefined; }
    if (!raw || typeof raw !== "object") return undefined;
    const obj = raw as Record<string, unknown>;

    // Shape 1: {type:"assistant", message:{content:[{type:"text", text:"..."}]}}
    if (obj["type"] === "assistant" && obj["message"] && typeof obj["message"] === "object") {
      const msg = obj["message"] as Record<string, unknown>;
      if (Array.isArray(msg["content"])) {
        let buf = "";
        for (const block of msg["content"] as unknown[]) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b["type"] === "text" && typeof b["text"] === "string") {
              buf += b["text"];
            }
          }
        }
        return buf.length > 0 ? buf : undefined;
      }
    }

    // Shape 2: {type:"content_block_delta", delta:{type:"text_delta", text:"..."}}
    if (obj["type"] === "content_block_delta" && obj["delta"] && typeof obj["delta"] === "object") {
      const delta = obj["delta"] as Record<string, unknown>;
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        return delta["text"].length > 0 ? delta["text"] : undefined;
      }
    }

    // All other event types (system, result, tool_use, etc.) carry no streaming text.
    return undefined;
  }

  parseStdout(stdout: string): SubscriptionCliParsedResult {
    const trimmed = stdout.trim();

    // Fast path: single-JSON output (non-streaming / --output-format=json).
    let raw: unknown;
    try { raw = JSON.parse(trimmed); }
    catch {
      // Could be NDJSON from --output-format=stream-json. Scan all lines and
      // pick the one with type:"result" which carries the final accumulated text
      // and usage info. Fall back to using raw trimmed stdout as content.
      return this._parseNdjsonOrFallback(stdout, trimmed);
    }

    return this._extractFromObject(raw, trimmed);
  }

  private _parseNdjsonOrFallback(stdout: string, fallbackContent: string): SubscriptionCliParsedResult {
    // Scan each line for a JSON object with type:"result".
    let resultLine: Record<string, unknown> | undefined;
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let obj: unknown;
      try { obj = JSON.parse(t); } catch { continue; }
      if (obj && typeof obj === "object") {
        const o = obj as Record<string, unknown>;
        if (o["type"] === "result") {
          resultLine = o;
          break;
        }
      }
    }
    if (resultLine) {
      return this._extractFromObject(resultLine, fallbackContent);
    }
    // No result line found — return raw content with no usage
    return { content: fallbackContent || stdout.trim(), raw: stdout };
  }

  private _extractFromObject(raw: unknown, fallbackContent: string): SubscriptionCliParsedResult {
    const r = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : null;
    const content =
      r && (
        (typeof r["result"] === "string"  && r["result"]) ||
        (typeof r["content"] === "string" && r["content"]) ||
        (typeof r["text"] === "string"    && r["text"]) ||
        (typeof r["message"] === "string" && r["message"])
      ) || fallbackContent;

    const usage = (r && typeof r["usage"] === "object" && r["usage"] !== null)
      ? (r["usage"] as Record<string, unknown>) : undefined;
    const inputTokens  = pickNonNegativeFinite(usage?.["input_tokens"],  usage?.["inputTokens"]);
    const outputTokens = pickNonNegativeFinite(usage?.["output_tokens"], usage?.["outputTokens"]);

    return {
      content: typeof content === "string" ? content : JSON.stringify(content),
      ...(inputTokens  !== undefined ? { inputTokens  } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      raw,
    };
  }
}
