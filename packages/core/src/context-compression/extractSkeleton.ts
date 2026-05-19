import type { SourceLanguage, SymbolEntry } from "./types.js";

type LinePattern = { kind: SymbolEntry["kind"]; re: RegExp };

const PATTERNS_TS: LinePattern[] = [
  { kind: "import",    re: /^\s*import\b/ },
  { kind: "export",    re: /^\s*export\s+(?!function|class|interface|type|const|default|async)/ },
  { kind: "function",  re: /^\s*(export\s+)?(async\s+)?function\b/ },
  { kind: "class",     re: /^\s*(export\s+)?(abstract\s+)?class\b/ },
  { kind: "interface", re: /^\s*(export\s+)?interface\b/ },
  { kind: "type",      re: /^\s*(export\s+)?type\s+\w/ },
  { kind: "const",     re: /^\s*(export\s+)?const\b/ },
];

const PATTERNS_PY: LinePattern[] = [
  { kind: "import",   re: /^\s*(import|from)\b/ },
  { kind: "function", re: /^\s*(async\s+)?def\b/ },
  { kind: "class",    re: /^\s*class\b/ },
];

const PATTERNS_GO: LinePattern[] = [
  { kind: "import",   re: /^\s*import\b/ },
  { kind: "function", re: /^\s*func\b/ },
  { kind: "type",     re: /^\s*type\b/ },
];

const PATTERNS_RS: LinePattern[] = [
  { kind: "import",   re: /^\s*use\b/ },
  { kind: "function", re: /^\s*(pub\s+)?(async\s+)?fn\b/ },
  { kind: "type",     re: /^\s*(pub\s+)?(struct|enum|trait|impl)\b/ },
];

const PATTERNS_FALLBACK: LinePattern[] = [
  { kind: "import", re: /^\s*(import|use|require|from|#include)\b/ },
];

function patternsFor(lang: SourceLanguage): LinePattern[] {
  switch (lang) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return PATTERNS_TS;
    case "py":
      return PATTERNS_PY;
    case "go":
      return PATTERNS_GO;
    case "rs":
      return PATTERNS_RS;
    default:
      return PATTERNS_FALLBACK;
  }
}

export function extractSkeleton(source: string, language: SourceLanguage): SymbolEntry[] {
  const patterns = patternsFor(language);
  const lines = source.split("\n");
  const out: SymbolEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const p of patterns) {
      if (p.re.test(line)) {
        out.push({ kind: p.kind, line: i + 1, text: line.trimEnd() });
        break;
      }
    }
  }
  return out;
}
