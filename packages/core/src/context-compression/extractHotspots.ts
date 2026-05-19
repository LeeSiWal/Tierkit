import type { Hotspot } from "./types.js";

export interface ExtractHotspotsOptions {
  maxHotspots: number;
  contextLines: number;
}

export interface ExtractHotspotsResult {
  hotspots: Hotspot[];
  omittedLineRanges: Array<[number, number]>;
}

interface Window {
  startLine: number;
  endLine: number;
  matchedTerms: Set<string>;
  density: number; // # of matches inside the window
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractHotspots(
  source: string,
  keywords: string[],
  opts: ExtractHotspotsOptions,
): ExtractHotspotsResult {
  const lines = source.split("\n");
  const total = lines.length;

  // 1. Find all match lines per keyword (case-insensitive).
  const matches: Array<{ line: number; term: string }> = [];
  for (const kw of keywords) {
    const re = new RegExp(escapeRegExp(kw), "i");
    for (let i = 0; i < total; i += 1) {
      if (re.test(lines[i])) matches.push({ line: i + 1, term: kw });
    }
  }

  if (matches.length === 0) {
    return {
      hotspots: [],
      omittedLineRanges: total > 0 ? [[1, total]] : [],
    };
  }

  // 2. Build per-match windows, then merge adjacent/overlapping ones.
  const rawWindows: Window[] = matches.map((m) => ({
    startLine: Math.max(1, m.line - opts.contextLines),
    endLine: Math.min(total, m.line + opts.contextLines),
    matchedTerms: new Set([m.term]),
    density: 1,
  }));
  rawWindows.sort((a, b) => a.startLine - b.startLine);

  const merged: Window[] = [];
  for (const w of rawWindows) {
    const last = merged[merged.length - 1];
    if (last && w.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, w.endLine);
      for (const t of w.matchedTerms) last.matchedTerms.add(t);
      last.density += w.density;
    } else {
      merged.push({ ...w, matchedTerms: new Set(w.matchedTerms) });
    }
  }

  // 3. Cap at maxHotspots by density (ties broken by earlier startLine).
  merged.sort((a, b) => {
    if (b.density !== a.density) return b.density - a.density;
    return a.startLine - b.startLine;
  });
  const kept = merged.slice(0, opts.maxHotspots);
  kept.sort((a, b) => a.startLine - b.startLine);

  const hotspots: Hotspot[] = kept.map((w) => ({
    startLine: w.startLine,
    endLine: w.endLine,
    matchedTerms: [...w.matchedTerms].sort(),
    code: lines.slice(w.startLine - 1, w.endLine).join("\n"),
  }));

  // 4. Compute omittedLineRanges as complement.
  const omitted: Array<[number, number]> = [];
  let cursor = 1;
  for (const h of hotspots) {
    if (h.startLine > cursor) omitted.push([cursor, h.startLine - 1]);
    cursor = h.endLine + 1;
  }
  if (cursor <= total) omitted.push([cursor, total]);

  return { hotspots, omittedLineRanges: omitted };
}
