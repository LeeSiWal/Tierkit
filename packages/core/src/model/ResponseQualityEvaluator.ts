import { matchesRefusal } from "./refusalPatterns.js";

export type QualityReason = "empty" | "refusal" | "truncated" | "repetition";

export interface QualityVerdict {
  acceptable: boolean;
  reason?: QualityReason;
}

const TERMINATORS = /[.!?。、:;\]\)}」』]$/;

/**
 * Post-response quality check. Pure function, no I/O.
 *
 * Heuristics (any failing → unacceptable):
 *   - empty: trimmed length 0, OR length < 20 when the prompt is substantial (>100 chars)
 *   - refusal: head matches a known refusal pattern
 *   - truncated: finishReason indicates a non-graceful stop AND text ends mid-sentence
 *   - repetition: last 80 chars equal the preceding 80 chars (loop detector)
 */
export function evaluateResponse(
  text: string,
  finishReason: string | undefined,
  prompt: string,
): QualityVerdict {
  const trimmed = text.trim();

  if (trimmed.length === 0) return { acceptable: false, reason: "empty" };
  if (trimmed.length < 10 && prompt.length > 100) {
    return { acceptable: false, reason: "empty" };
  }

  if (matchesRefusal(trimmed)) return { acceptable: false, reason: "refusal" };

  if (finishReason && finishReason !== "stop") {
    const tail = trimmed.slice(-1);
    if (tail && !TERMINATORS.test(tail)) {
      return { acceptable: false, reason: "truncated" };
    }
  }

  if (trimmed.length >= 160) {
    const lastSeg = trimmed.slice(-80);
    const prevSeg = trimmed.slice(-160, -80);
    if (lastSeg === prevSeg) return { acceptable: false, reason: "repetition" };
  }

  return { acceptable: true };
}
