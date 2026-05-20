import type { CompareResult, ContextArtifact } from "../context-compression/types.js";

export type CompareSsePhase = "baseline-start" | "baseline-end" | "compressed-start" | "compressed-end";
export type CompareSseSide = "baseline" | "compressed";

export type CompareSseEvent =
  | { event: "phase";        data: { phase: CompareSsePhase } }
  | { event: "delta";        data: { side: CompareSseSide; text: string } }
  | { event: "side-result";  data: {
      side: CompareSseSide;
      actualInputTokens?: number;
      actualOutputTokens?: number;
      actualCostUsd?: number;
      latencyMs?: number;
      failureCode?: string;
    } }
  | { event: "compare-done"; data: { compare: CompareResult; artifact: ContextArtifact } }
  | { event: "error";        data: { code: string; message: string; side?: CompareSseSide } };
