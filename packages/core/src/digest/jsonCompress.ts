/**
 * compressJson — turn a huge API response into a SHAPE description.
 *
 * Use case: Claude Code needs to know the *structure* of a response, not the
 * 10,000 sample rows in it. We walk the JSON, keep field names + nesting, and
 * elide actual values:
 *
 *   Input  (10,000-item array of {id, name, email, profile: {...}}):
 *     [{"id": 1, "name": "Alice", "email": "alice@x.com", "profile": {...}}, ...]
 *
 *   Output (the shape + first item as sample):
 *     object {
 *       - id: number
 *       - name: string ("Alice")
 *       - email: string ("alice@x.com")
 *       - profile: object { ... }
 *     }   (sample of 10000 items)
 *
 * What gets dropped:
 *   - Repeated array items past the configured sample size (default 1)
 *   - String contents past maxStringLen (default 80 chars)
 *   - Nesting deeper than maxDepth (default 8 levels)
 *
 * What gets kept:
 *   - Every field name at every level → fieldPaths list
 *   - The type of each field
 *   - The first sample value of strings
 *   - Possible envelope-shape mismatches (both `success` + `error` keys, etc.)
 *
 * Handles invalid JSON gracefully — if `JSON.parse` throws, the input is
 * treated as a string and surfaced in `uncertainty`. No exceptions escape.
 */
import {
  DEFAULT_DIGEST_BUDGET,
  type DigestBudget,
  type JsonDigest,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

export interface CompressJsonOptions {
  budget?: Partial<DigestBudget>;
  /** Max nesting depth to walk before collapsing to `<deep>`. Default 8. */
  maxDepth?: number;
  /** Max string length before truncating. Default 80. */
  maxStringLen?: number;
  /** Max array sample shape entries. Default 1. */
  arraySampleSize?: number;
}

interface CompressOpts {
  maxDepth: number;
  maxStringLen: number;
  arraySampleSize: number;
}

type Shape =
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string"; sample?: string; truncated?: boolean }
  | { kind: "array"; length: number; items?: Shape }
  | { kind: "object"; fields: Record<string, Shape> }
  | { kind: "deep" };

function compressShape(value: unknown, opts: CompressOpts, depth: number, paths: string[], currentPath: string): Shape {
  if (depth > opts.maxDepth) return { kind: "deep" };
  if (value === null) return { kind: "null" };
  const t = typeof value;
  if (t === "boolean") return { kind: "boolean" };
  if (t === "number") return { kind: "number" };
  if (t === "string") {
    const s = value as string;
    const truncated = s.length > opts.maxStringLen;
    return {
      kind: "string",
      sample: truncated ? s.slice(0, opts.maxStringLen) + "…" : s,
      truncated,
    };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", length: 0 };
    const sample = value.slice(0, opts.arraySampleSize);
    const items = sample.map((v, idx) =>
      compressShape(v, opts, depth + 1, paths, `${currentPath}[${idx}]`),
    );
    // Merge sample shapes if they have the same kind.
    const merged = mergeArrayItemShapes(items);
    return { kind: "array", length: value.length, items: merged };
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const fields: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(obj)) {
      const nextPath = currentPath ? `${currentPath}.${k}` : k;
      paths.push(nextPath);
      fields[k] = compressShape(v, opts, depth + 1, paths, nextPath);
    }
    return { kind: "object", fields };
  }
  return { kind: "deep" };
}

function mergeArrayItemShapes(items: Shape[]): Shape | undefined {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  // If all same kind, return first; else return as-is.
  const kinds = new Set(items.map((s) => s.kind));
  if (kinds.size === 1) return items[0];
  // Mixed kinds — fall back to a synthesized "any" via deep marker.
  return { kind: "deep" };
}

function renderShapeMd(shape: Shape, indent: string): string {
  switch (shape.kind) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string": {
      const sample = shape.sample ?? "";
      return `string${shape.truncated ? ` (truncated; sample: "${sample}")` : ` ("${sample}")`}`;
    }
    case "deep":
      return "<deep>";
    case "array": {
      if (shape.length === 0) return "array (empty)";
      if (!shape.items) return `array (length ${shape.length})`;
      return `array (length ${shape.length}) of\n${indent}  - ${renderShapeMd(shape.items, indent + "  ")}`;
    }
    case "object": {
      const entries = Object.entries(shape.fields);
      if (entries.length === 0) return "object {}";
      const lines = [`object {`];
      for (const [k, v] of entries) {
        lines.push(`${indent}  - ${k}: ${renderShapeMd(v, indent + "  ")}`);
      }
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
  }
}

export function compressJson(
  input: string,
  options: CompressJsonOptions = {},
): JsonDigest {
  const budget = { ...DEFAULT_DIGEST_BUDGET, ...options.budget };
  const opts: CompressOpts = {
    maxDepth: options.maxDepth ?? 8,
    maxStringLen: options.maxStringLen ?? 80,
    arraySampleSize: options.arraySampleSize ?? 1,
  };

  let parsed: unknown;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    parseError = (err as Error).message;
  }

  const fieldPaths: string[] = [];
  let shape: Shape;
  if (parseError) {
    shape = { kind: "string", sample: input.slice(0, opts.maxStringLen), truncated: input.length > opts.maxStringLen };
  } else {
    shape = compressShape(parsed, opts, 0, fieldPaths, "");
  }

  // Truncate field paths to budget.
  const truncatedPaths = fieldPaths.slice(0, budget.maxItems * 4);

  const uncertainty: string[] = [];
  if (parseError) {
    uncertainty.push(`Input is not valid JSON: ${parseError}. Shape reflects raw text only.`);
  }
  if (fieldPaths.length > truncatedPaths.length) {
    uncertainty.push(`Field path list truncated (${truncatedPaths.length} of ${fieldPaths.length} shown).`);
  }

  // Possible mismatches: detect common patterns that often differ between expected/actual API shapes.
  const possibleMismatches = detectMismatches(shape);

  const summaryMd = renderJsonDigestMd(shape, truncatedPaths, possibleMismatches, parseError);
  const stats = computeStats(input, summaryMd);

  return {
    id: makeDigestId("json"),
    summaryMd,
    shape,
    fieldPaths: truncatedPaths,
    possibleMismatches,
    uncertainty,
    stats,
    verdict: "not-evaluated",
  };
}

function detectMismatches(shape: Shape): string[] {
  const out: string[] = [];
  walkForMismatches(shape, "", out);
  return out;
}

function walkForMismatches(shape: Shape, path: string, out: string[]): void {
  if (shape.kind === "object") {
    const keys = Object.keys(shape.fields);
    // Heuristic: presence of both `success` and `error` on the same object often hints at envelope inconsistency.
    if (keys.includes("success") && keys.includes("error")) {
      out.push(`${path || "<root>"}: contains both 'success' and 'error' keys — verify expected envelope shape.`);
    }
    // Heuristic: ok:false but no error.code
    if (shape.fields.ok?.kind === "boolean" && !shape.fields.error && !shape.fields.code) {
      out.push(`${path || "<root>"}: 'ok' flag present without 'error' or 'code' — verify error envelope.`);
    }
    for (const [k, v] of Object.entries(shape.fields)) {
      walkForMismatches(v, path ? `${path}.${k}` : k, out);
    }
  } else if (shape.kind === "array" && shape.items) {
    walkForMismatches(shape.items, `${path}[]`, out);
  }
}

function renderJsonDigestMd(
  shape: Shape,
  paths: string[],
  mismatches: string[],
  parseError: string | null,
): string {
  const lines: string[] = [];
  lines.push("# JSON Digest");
  lines.push("");
  if (parseError) {
    lines.push(`**Parse error:** ${parseError}`);
    lines.push("");
  }
  lines.push("## Shape");
  lines.push("```");
  lines.push(renderShapeMd(shape, ""));
  lines.push("```");
  if (paths.length > 0) {
    lines.push("");
    lines.push(`## Field paths (${paths.length})`);
    for (const p of paths.slice(0, 40)) {
      lines.push(`- ${p}`);
    }
    if (paths.length > 40) {
      lines.push(`- … (+${paths.length - 40} more)`);
    }
  }
  if (mismatches.length > 0) {
    lines.push("");
    lines.push("## Possible mismatches");
    for (const m of mismatches) lines.push(`- ${m}`);
  }
  return lines.join("\n");
}
