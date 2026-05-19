export const KEYWORD_CAP = 12;

const STOPWORDS = new Set([
  "a", "an", "the",
  "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "by", "to", "for", "with", "from", "as",
  "and", "or", "but", "if", "then", "so", "yet",
  "this", "that", "these", "those",
  "it", "its", "we", "you", "they",
  "do", "does", "did", "have", "has", "had",
  "not", "no",
  "my", "your", "our", "their",
  "i", "me",
]);

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_-]*[A-Za-z0-9_]$/;
// An identifier must be distinguishable from a plain word: contain a
// separator (`_`/`-`) or an internal capital (camelCase / PascalCase mid-word).
// A single leading capital alone (e.g. "Payment") is treated as a general word.
const HAS_SEPARATOR = /[_-]/;
const HAS_INNER_CAPITAL = /[A-Za-z][A-Z]/;

interface Token {
  text: string;
  kind: "quoted" | "identifier" | "general";
}

function isIdentifier(word: string): boolean {
  if (!IDENTIFIER_RE.test(word)) return false;
  return HAS_SEPARATOR.test(word) || HAS_INNER_CAPITAL.test(word);
}

export function extractKeywords(task: string): string[] {
  const tokens: Token[] = [];
  const seen = new Set<string>();

  let remaining = task;

  // 1. Pull out quoted phrases first.
  const quoteRe = /"([^"]+)"|'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(task)) !== null) {
    const phrase = (m[1] ?? m[2] ?? "").trim();
    if (phrase.length > 0) {
      const key = `quoted::${phrase.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        tokens.push({ text: phrase.toLowerCase(), kind: "quoted" });
      }
    }
  }
  remaining = task.replace(quoteRe, " ");

  // 2. Split rest on whitespace and punctuation (keeping identifier chars).
  const words = remaining.split(/[\s,.;:!?()[\]{}<>]+/).filter(Boolean);

  for (const raw of words) {
    const word = raw.trim();
    if (word.length === 0) continue;

    if (isIdentifier(word)) {
      // Preserve original casing for identifiers.
      const key = `ident::${word}`;
      if (!seen.has(key)) {
        seen.add(key);
        tokens.push({ text: word, kind: "identifier" });
      }
      continue;
    }

    const lowered = word.toLowerCase();
    if (STOPWORDS.has(lowered)) continue;
    if (lowered.length < 3) continue;

    const key = `gen::${lowered}`;
    if (!seen.has(key)) {
      seen.add(key);
      tokens.push({ text: lowered, kind: "general" });
    }
  }

  // 3. Priority sort: quoted > identifier > general (stable within each).
  const priority: Record<Token["kind"], number> = {
    quoted: 0,
    identifier: 1,
    general: 2,
  };
  tokens.sort((a, b) => priority[a.kind] - priority[b.kind]);

  // 4. Cap.
  return tokens.slice(0, KEYWORD_CAP).map((t) => t.text);
}
